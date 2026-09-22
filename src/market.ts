import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Config } from "./config.js";
import { CreditManager, type BookState, type OrderState, type RefuelRecord, type SellRecord } from "./credit-manager.js";
import { createLogger } from "./logger.js";

const log = createLogger("market");
const ORDERS_FILE = ".agent-orders.json";

interface StoredOrder {
  orderId: string;
  credit: number;
  price: number;
  txHash?: string;
  at: string;
}

export interface RebalanceResult {
  /** Ask placed this round, if any. */
  sold?: SellRecord;
  /** Inventory bought this round, if any. */
  bought?: RefuelRecord;
  /** Our asks still open after this round. */
  open: OrderState[];
  notes: string[];
}

/**
 * MarketMaker — "earn credits to feed yourself".
 *
 * The agent normally buys CREDIT and activates it straight into its API balance. Any CREDIT it
 * *holds* unactivated (bought with `buy`, restocked here, or received by transfer) is inventory:
 *  - surplus above CREDIT_RESERVE is listed on the Exchange order book with `sell` at
 *    max(best ask, SELL_MIN_PRICE), rounded up to the book's price tick;
 *  - when the book is cheap (discount ≥ INVENTORY_DISCOUNT) and the previous batch has sold,
 *    INVENTORY_USDG worth of CREDIT is bought to hold, under the same budget guard as refuels.
 * Fills pay USDG straight to the wallet, where the next refuel picks it up. Whether asks fill,
 * and how fast, depends entirely on other buyers; nothing here guarantees a profit.
 */
export class MarketMaker {
  constructor(
    private readonly cfg: Config,
    private readonly credit: CreditManager,
    private readonly persist = true,
    private orders: StoredOrder[] = [],
  ) {
    if (persist) this.orders = this.load();
  }

  private load(): StoredOrder[] {
    if (!existsSync(ORDERS_FILE)) return [];
    try {
      const parsed = JSON.parse(readFileSync(ORDERS_FILE, "utf8")) as { orders?: StoredOrder[] };
      return Array.isArray(parsed.orders) ? parsed.orders : [];
    } catch {
      return [];
    }
  }

  private save() {
    if (this.persist) writeFileSync(ORDERS_FILE, JSON.stringify({ orders: this.orders }, null, 2));
  }

  /** Remember an ask so `orders` can report on it in later runs. */
  track(rec: SellRecord) {
    if (!rec.orderId || rec.dryRun) return;
    this.orders.push({ orderId: rec.orderId, credit: rec.credit, price: rec.price, txHash: rec.txHash, at: rec.at });
    this.save();
  }

  get trackedIds(): string[] {
    return this.orders.map((o) => o.orderId);
  }

  /** Refresh every tracked ask from the chain; filled and cancelled ones are reported once and forgotten. */
  async openOrders(): Promise<OrderState[]> {
    const open: OrderState[] = [];
    const keep: StoredOrder[] = [];
    for (const o of this.orders) {
      const state = await this.credit.orderOf(o.orderId);
      if (state.status === "open") {
        open.push(state);
        keep.push(o);
      } else if (state.status === "filled") {
        log.info(`Ask ${o.orderId} filled: ${state.filled.toFixed(4)} CREDIT sold at ${state.price.toFixed(4)} → ${(state.filled * state.price).toFixed(4)} USDG received`);
      } else {
        log.info(`Ask ${o.orderId} is ${state.status}; no longer tracked`);
      }
    }
    if (keep.length !== this.orders.length) {
      this.orders = keep;
      this.save();
    }
    return open;
  }

  /** CREDIT held in the wallet beyond the reserve. */
  async surplus(): Promise<{ held: number; surplus: number }> {
    const { credit: held } = await this.credit.walletBalances();
    return { held, surplus: Math.max(0, held - this.cfg.CREDIT_RESERVE) };
  }

  /** List the surplus if it meets the Exchange minimum. Returns the ask, or undefined when nothing was listed. */
  async listSurplus(book?: BookState): Promise<SellRecord | undefined> {
    const b = book ?? (await this.credit.book());
    const { held, surplus } = await this.surplus();
    if (surplus < b.minOrder) {
      log.info(`Nothing to list: holding ${held.toFixed(4)} CREDIT, reserve ${this.cfg.CREDIT_RESERVE}, Exchange minimum ${b.minOrder} CREDIT`);
      return undefined;
    }
    const priceRaw = CreditManager.choosePrice(b.bestPriceRaw, this.cfg.SELL_MIN_PRICE, b.priceScale, b.priceTick);
    log.info(
      `Listing ${surplus.toFixed(4)} CREDIT: best ask ${b.bestPrice ? b.bestPrice.toFixed(4) : "none"}, floor ${this.cfg.SELL_MIN_PRICE} → ask ${(priceRaw / b.priceScale).toFixed(4)} USDG/CREDIT`,
    );
    const rec = await this.credit.sell(surplus, priceRaw);
    this.track(rec);
    return rec;
  }

  /**
   * Buy a batch of CREDIT to hold when the book is cheap. One batch at a time: skipped while we
   * still hold a listable amount or have asks open, so capital at risk stays at INVENTORY_USDG.
   */
  async restock(book: BookState, open: OrderState[]): Promise<RefuelRecord | undefined> {
    if (this.cfg.INVENTORY_USDG <= 0) return undefined;
    const { surplus } = await this.surplus();
    if (open.length > 0 || surplus >= book.minOrder) {
      log.info(`Restock skipped: ${open.length} ask(s) open, ${surplus.toFixed(4)} CREDIT unlisted`);
      return undefined;
    }
    const q = await this.credit.quote(this.cfg.INVENTORY_USDG);
    if (!CreditManager.acceptable(q, this.cfg.INVENTORY_DISCOUNT)) {
      log.info(`Restock skipped: book discount ${(q.discount * 100).toFixed(1)}% < INVENTORY_DISCOUNT ${(this.cfg.INVENTORY_DISCOUNT * 100).toFixed(0)}%`);
      return undefined;
    }
    log.info(`Restocking: ${this.cfg.INVENTORY_USDG} USDG → ${q.creditOut.toFixed(4)} CREDIT at ${(q.discount * 100).toFixed(1)}% off (to hold, not activate)`);
    return this.credit.buyHeld(this.cfg.INVENTORY_USDG, this.cfg.INVENTORY_DISCOUNT);
  }

  /** One maintenance round: settle finished asks → restock if cheap → list the surplus. Never throws on policy refusals. */
  async rebalance(): Promise<RebalanceResult> {
    const notes: string[] = [];
    const book = await this.credit.book();
    log.info(`Book: best ask ${book.bestPrice ? book.bestPrice.toFixed(4) : "none"}, ${book.depthCredit.toFixed(2)} CREDIT in ${book.openOrders} order(s), min order ${book.minOrder} CREDIT, fee ${book.feeBps} bps`);
    let open = await this.openOrders();
    let bought: RefuelRecord | undefined;
    let sold: SellRecord | undefined;
    try {
      bought = await this.restock(book, open);
    } catch (err) {
      notes.push(`restock refused: ${err instanceof Error ? err.message : String(err)}`);
      log.warn(notes[notes.length - 1]!);
    }
    try {
      sold = await this.listSurplus(book);
      if (sold) open = await this.openOrders();
    } catch (err) {
      notes.push(`listing failed: ${err instanceof Error ? err.message : String(err)}`);
      log.warn(notes[notes.length - 1]!);
    }
    return { sold, bought, open, notes };
  }
}
