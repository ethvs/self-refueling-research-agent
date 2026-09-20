import { formatUnits, pad, parseUnits, type Address, type Hex } from "viem";
import { creditAbi, erc20Abi, exchangeAbi, TOKEN_DECIMALS } from "./abi/orbio.js";
import { BudgetGuard } from "./budget.js";
import { CONSTANTS, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { sleep, withRetry } from "./retry.js";
import type { WalletManager } from "./wallet.js";

const log = createLogger("credit");

export interface KeyInfo {
  available: number; // USD
  used: number; // USD
  rateLimit?: { requests_per_minute?: number; concurrent?: number };
}

export interface Quote {
  usdgIn: number;
  creditOut: number;
  usdgSpent: number;
  feeAtoms: number;
  fills: number;
  reason: number;
  /** effective price in USDG per CREDIT (incl. fee) */
  price: number;
  /** 1 - price */
  discount: number;
}

export interface RefuelRecord {
  usdgSpent: number;
  creditOut: number;
  price: number;
  discount: number;
  fills: number;
  /** Set when the activation was made for another wallet (worker funding). */
  beneficiary?: Address;
  txHash?: string;
  activationId?: string;
  dryRun: boolean;
  at: string;
}

const toUnits = (n: number) => parseUnits(n.toFixed(TOKEN_DECIMALS), TOKEN_DECIMALS);
const fromUnits = (n: bigint) => Number(formatUnits(n, TOKEN_DECIMALS));

/** Conservative gas budgets used only for the pre-flight balance check. */
const GAS_UNITS = { approve: 60_000n, buyAndActivate: 350_000n, activate: 150_000n, transfer: 70_000n } as const;

/** Errors that will not go away by retrying the same transaction. */
function isDeterministicChainError(err: unknown): boolean {
  const e = err as { name?: string; shortMessage?: string; message?: string };
  const m = `${e?.name ?? ""} ${e?.shortMessage ?? ""} ${e?.message ?? ""}`;
  return /InsufficientFunds|insufficient funds|exceeds allowance|exceeds the balance|reverted|Insufficient (gas|USDG|CREDIT)/i.test(m);
}

/**
 * CreditManager
 *  - reads the activated API balance from GET /api/v1/key
 *  - quotes the Exchange order book (getQuote) and enforces a discount floor
 *  - approves USDG and calls buyAndActivate, within budget
 *  - can also activate CREDIT already held (credit.activate)
 */
export class CreditManager {
  readonly refuels: RefuelRecord[] = [];

  constructor(
    protected readonly cfg: Config,
    protected readonly wallet: WalletManager,
    protected readonly budget: BudgetGuard,
  ) {}

  // ---------- API balance ----------

  async getKeyInfo(): Promise<KeyInfo> {
    const key = this.wallet.getApiKey();
    const url = this.cfg.ORBIO_API_BASE.replace(/\/$/, "") + "/key";
    return withRetry(
      "GET /key",
      async () => {
        const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
        if (res.status === 401) {
          // The gateway only knows a wallet once CREDIT has been activated for it.
          log.warn("Gateway does not know this key yet (401). Treating API balance as $0 until the first activation.");
          return { available: 0, used: 0 };
        }
        if (!res.ok) throw new Error(`key request failed: ${res.status} ${await res.text()}`);
        const data = (await res.json()) as {
          balance?: { available?: string | number; used?: string | number };
          rate_limit?: KeyInfo["rateLimit"];
        };
        const available = Number(data.balance?.available ?? NaN);
        if (Number.isNaN(available)) throw new Error(`unexpected /key response: ${JSON.stringify(data)}`);
        return { available, used: Number(data.balance?.used ?? 0), rateLimit: data.rate_limit };
      },
      log,
    );
  }

  /** Read the API balance of an arbitrary wallet given its API key (used to watch worker activations). */
  static async balanceForKey(apiBase: string, key: string): Promise<number> {
    const res = await fetch(apiBase.replace(/\/$/, "") + "/key", { headers: { authorization: `Bearer ${key}` } });
    if (res.status === 401) return 0;
    if (!res.ok) throw new Error(`key request failed: ${res.status}`);
    const data = (await res.json()) as { balance?: { available?: string | number } };
    return Number(data.balance?.available ?? 0);
  }

  async getBalance(): Promise<number> {
    return (await this.getKeyInfo()).available;
  }

  /** Returns true if a refuel was performed. Pass `known` to reuse a balance read a moment ago. */
  async ensureFuel(known?: number): Promise<boolean> {
    const bal = known ?? (await this.getBalance());
    log.info(`API balance: $${bal.toFixed(4)} (threshold $${this.cfg.CREDIT_LOW_THRESHOLD})`);
    if (bal >= this.cfg.CREDIT_LOW_THRESHOLD) return false;
    log.warn("Balance below threshold, refueling…");
    await this.refuel(this.cfg.REFUEL_USDG);
    return true;
  }

  /** Refuel with the configured amount right now (the gateway reported an exhausted balance mid-task). */
  async refuelNow(): Promise<RefuelRecord> {
    return this.refuel(this.cfg.REFUEL_USDG);
  }

  // ---------- on-chain reads ----------

  async walletBalances(): Promise<{ usdg: number; credit: number; eth: number }> {
    const pc = this.wallet.publicClient;
    const [usdg, credit, eth] = await Promise.all([
      pc.readContract({ address: this.cfg.USDG_ADDRESS as Address, abi: erc20Abi, functionName: "balanceOf", args: [this.wallet.address] }),
      pc.readContract({ address: this.cfg.CREDIT_ADDRESS as Address, abi: creditAbi, functionName: "balanceOf", args: [this.wallet.address] }),
      pc.getBalance({ address: this.wallet.address }),
    ]);
    return { usdg: fromUnits(usdg), credit: fromUnits(credit), eth: Number(formatUnits(eth, 18)) };
  }

  /** Quote how much CREDIT `usdgIn` buys from the order book right now. */
  async quote(usdgIn: number, maxFills = this.cfg.MAX_FILLS): Promise<Quote> {
    const q = await this.wallet.publicClient.readContract({
      address: this.cfg.EXCHANGE_ADDRESS as Address,
      abi: exchangeAbi,
      functionName: "getQuote",
      args: [toUnits(usdgIn), BigInt(maxFills)],
    });
    const creditOut = fromUnits(q.creditOut);
    const usdgSpent = fromUnits(q.usdgSpent);
    const feeAtoms = fromUnits(q.feeAtoms);
    const paid = usdgSpent + feeAtoms;
    const price = creditOut > 0 ? paid / creditOut : Infinity;
    return {
      usdgIn,
      creditOut,
      usdgSpent,
      feeAtoms,
      fills: Number(q.fills),
      reason: Number(q.reason),
      price,
      discount: 1 - price,
    };
  }

  /** Pure policy check, unit-tested. */
  static acceptable(q: Pick<Quote, "creditOut" | "discount">, minDiscount: number): boolean {
    return q.creditOut > 0 && q.discount >= minDiscount;
  }

  // ---------- purchase ----------

  async refuel(usdgIn: number): Promise<RefuelRecord> {
    return this.purchase(usdgIn, this.wallet.address, () => this.getBalance());
  }

  /**
   * Buy CREDIT from the order book and activate it straight into `beneficiary`'s API balance.
   * The coordinator uses this to fund worker agents that hold no gas or USDG themselves.
   * `readBalance` reads the beneficiary's API balance so we can wait for the activation to land.
   */
  async purchase(usdgIn: number, beneficiary: Address, readBalance: () => Promise<number>): Promise<RefuelRecord> {
    const q = await this.quote(usdgIn);
    const forSelf = beneficiary.toLowerCase() === this.wallet.address.toLowerCase();
    log.info(
      `Quote: ${usdgIn} USDG → ${q.creditOut.toFixed(4)} CREDIT via ${q.fills} fill(s), fee ${q.feeAtoms.toFixed(4)}, price ${q.price.toFixed(4)} (${(q.discount * 100).toFixed(1)}% off)${forSelf ? "" : ` for ${beneficiary}`}`,
    );
    if (!CreditManager.acceptable(q, this.cfg.MIN_DISCOUNT)) {
      throw new Error(
        `Order book does not meet policy: discount ${(q.discount * 100).toFixed(1)}% < ${(this.cfg.MIN_DISCOUNT * 100).toFixed(0)}% (creditOut=${q.creditOut}, reason=${q.reason})`,
      );
    }
    const cost = q.usdgSpent + q.feeAtoms;
    this.budget.assertCanSpend(cost);

    const record: RefuelRecord = {
      usdgSpent: cost,
      creditOut: q.creditOut,
      price: q.price,
      discount: q.discount,
      fills: q.fills,
      beneficiary: forSelf ? undefined : beneficiary,
      dryRun: this.cfg.DRY_RUN,
      at: new Date().toISOString(),
    };

    if (this.cfg.DRY_RUN) {
      log.warn("DRY_RUN=true: skipping on-chain buyAndActivate");
      this.refuels.push(record);
      return record;
    }

    const before = await readBalance();
    await this.assertGas(GAS_UNITS.approve + GAS_UNITS.buyAndActivate);
    await this.assertTokenBalance(this.cfg.USDG_ADDRESS as Address, "USDG", toUnits(usdgIn));
    const { hash, activationId } = await withRetry(
      "buyAndActivate",
      () => this.buyAndActivate(usdgIn, q, beneficiary),
      log,
      CONSTANTS.MAX_RETRIES,
      isDeterministicChainError,
    );
    record.txHash = hash;
    record.activationId = activationId;
    this.budget.record(cost);
    this.refuels.push(record);
    await this.waitForBalanceIncrease(before, readBalance);
    return record;
  }

  private async buyAndActivate(usdgIn: number, q: Quote, beneficiaryAddr: Address): Promise<{ hash: Hex; activationId?: string }> {
    const { walletClient, publicClient, account, chain } = this.wallet;
    const ex = this.cfg.EXCHANGE_ADDRESS as Address;
    const usdg = this.cfg.USDG_ADDRESS as Address;
    const usdgInUnits = toUnits(usdgIn);
    // Accept up to 1% less CREDIT than quoted (book may move between quote and tx).
    const minCreditOut = (toUnits(q.creditOut) * 99n) / 100n;
    const beneficiary = pad(beneficiaryAddr, { size: 32 }); // bytes32(uint256(uint160(recipient)))

    await this.ensureAllowance(usdg, ex, usdgInUnits);

    log.info(`Sending buyAndActivate(usdgIn=${usdgIn}, minCreditOut=${fromUnits(minCreditOut)}, beneficiary=${beneficiaryAddr}, maxFills=${this.cfg.MAX_FILLS})`);
    const hash = await walletClient.writeContract({
      address: ex,
      abi: exchangeAbi,
      functionName: "buyAndActivate",
      args: [usdgInUnits, minCreditOut, beneficiary, BigInt(this.cfg.MAX_FILLS)],
      account,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`buyAndActivate reverted: ${hash}`);
    log.info(`buyAndActivate confirmed in block ${receipt.blockNumber}: ${hash}`);
    return { hash, activationId: this.findActivationId(receipt.logs) };
  }

  /**
   * Activate CREDIT already held in this wallet. With `beneficiary` the activated balance
   * lands in another wallet's API account (credit.activate(amount, bytes32 beneficiary)).
   */
  async activateHeld(amount: number, beneficiary?: Address): Promise<Hex> {
    const { walletClient, publicClient, account, chain } = this.wallet;
    const credit = this.cfg.CREDIT_ADDRESS as Address;
    const units = toUnits(amount);
    const [credited, fee] = await publicClient.readContract({
      address: credit,
      abi: creditAbi,
      functionName: "previewActivation",
      args: [units],
    });
    log.info(`previewActivation(${amount}): credited ${fromUnits(credited)}, fee ${fromUnits(fee)}${beneficiary ? ` → ${beneficiary}` : ""}`);
    if (this.cfg.DRY_RUN) {
      log.warn("DRY_RUN=true: skipping activate");
      return "0x";
    }
    await this.assertGas(GAS_UNITS.activate);
    await this.assertTokenBalance(credit, "CREDIT", units);
    const before = beneficiary ? 0 : await this.getBalance();
    const hash = beneficiary
      ? await walletClient.writeContract({
          address: credit,
          abi: creditAbi,
          functionName: "activate",
          args: [units, pad(beneficiary, { size: 32 })],
          account,
          chain,
        })
      : await walletClient.writeContract({
          address: credit,
          abi: creditAbi,
          functionName: "activate",
          args: [units],
          account,
          chain,
        });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`activate reverted: ${hash}`);
    log.info(`activate confirmed: ${hash}`);
    if (!beneficiary) await this.waitForBalanceIncrease(before, () => this.getBalance());
    return hash;
  }

  /** Plain ERC-20 transfer of unactivated CREDIT to another wallet (credit.transfer(worker, amount)). */
  async transferCredit(to: Address, amount: number): Promise<Hex> {
    const { walletClient, publicClient, account, chain } = this.wallet;
    log.info(`credit.transfer(${to}, ${amount})`);
    if (this.cfg.DRY_RUN) {
      log.warn("DRY_RUN=true: skipping transfer");
      return "0x";
    }
    await this.assertGas(GAS_UNITS.transfer);
    await this.assertTokenBalance(this.cfg.CREDIT_ADDRESS as Address, "CREDIT", toUnits(amount));
    const hash = await walletClient.writeContract({
      address: this.cfg.CREDIT_ADDRESS as Address,
      abi: creditAbi,
      functionName: "transfer",
      args: [to, toUnits(amount)],
      account,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transfer reverted: ${hash}`);
    log.info(`transfer confirmed: ${hash}`);
    return hash;
  }

  /**
   * Fail fast with an actionable message when the wallet cannot pay for gas,
   * instead of letting the node reject the transaction three times.
   */
  async assertGas(gasUnits: bigint): Promise<void> {
    const { publicClient, address } = this.wallet;
    const [balance, perGas] = await Promise.all([publicClient.getBalance({ address }), this.feePerGas()]);
    const needed = gasUnits * perGas;
    if (balance < needed) {
      throw new Error(
        `Insufficient gas: wallet ${address} holds ${formatUnits(balance, 18)} ETH but this transaction needs about ${formatUnits(needed, 18)} ETH at the current fee (${formatUnits(perGas, 9)} gwei). Send ETH on Robinhood Chain (chain ${this.cfg.CHAIN_ID}) to ${address} and retry.`,
      );
    }
  }

  /**
   * Fail fast when the wallet does not hold enough of a token for the transaction we are about to send.
   * approve() succeeds regardless of balance, so without this check we would pay for an approve and
   * then revert with the Exchange's InsufficientFunds() on buyAndActivate.
   */
  private async assertTokenBalance(token: Address, symbol: string, needed: bigint): Promise<void> {
    const held = await this.wallet.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.wallet.address],
    });
    if (held < needed) {
      throw new Error(
        `Insufficient ${symbol}: wallet ${this.wallet.address} holds ${fromUnits(held)} ${symbol} but this transaction needs ${fromUnits(needed)}. Send ${symbol} to that address and retry.`,
      );
    }
  }

  /** Rough ETH cost of one refuel (approve + buyAndActivate) at the current fee level. */
  async refuelGasCost(): Promise<number> {
    const perGas = await this.feePerGas();
    return Number(formatUnits((GAS_UNITS.approve + GAS_UNITS.buyAndActivate) * perGas, 18));
  }

  /** The fee cap viem will attach to a transaction; the node checks affordability against this. */
  private async feePerGas(): Promise<bigint> {
    const pc = this.wallet.publicClient;
    try {
      const f = await pc.estimateFeesPerGas();
      if (f.maxFeePerGas) return f.maxFeePerGas;
    } catch {
      /* legacy (non EIP-1559) chain: fall through to gasPrice */
    }
    return pc.getGasPrice();
  }

  private async ensureAllowance(token: Address, spender: Address, amount: bigint) {
    const { walletClient, publicClient, address, account, chain } = this.wallet;
    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, spender],
    });
    if (allowance >= amount) return;
    log.info(`Approving ${fromUnits(amount)} USDG for exchange`);
    const h = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
      account,
      chain,
    });
    const r = await publicClient.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`approve reverted: ${h}`);
    log.info(`approve confirmed: ${h}`);
  }

  /** Activated(activationId indexed, ...) → topic[1] */
  private findActivationId(logs: { address: Address; topics: readonly Hex[] }[]): string | undefined {
    const credit = this.cfg.CREDIT_ADDRESS.toLowerCase();
    for (const l of logs) {
      if (l.address.toLowerCase() === credit && l.topics.length === 4 && l.topics[1]) {
        return BigInt(l.topics[1]).toString();
      }
    }
    return undefined;
  }

  private async waitForBalanceIncrease(before: number, readBalance: () => Promise<number>) {
    for (let i = 0; i < CONSTANTS.ACTIVATION_POLL_MAX; i++) {
      await sleep(CONSTANTS.ACTIVATION_POLL_MS);
      const now = await readBalance().catch(() => before);
      if (now > before) {
        log.info(`API balance updated: $${before.toFixed(4)} → $${now.toFixed(4)}`);
        return;
      }
      log.debug(`waiting for activation (${i + 1}/${CONSTANTS.ACTIVATION_POLL_MAX})`);
    }
    log.warn("API balance did not increase within the polling window; continuing anyway");
  }

  totalSpent(): number {
    return this.refuels.filter((r) => !r.dryRun).reduce((s, r) => s + r.usdgSpent, 0);
  }
}
