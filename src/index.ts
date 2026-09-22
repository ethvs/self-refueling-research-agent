#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createLogger } from "./logger.js";
import { createRuntime } from "./runtime.js";
import { startServer } from "./server.js";
import { ResearchService } from "./service.js";
import { Coordinator, deriveWorkerKey } from "./team.js";
import { CreditManager } from "./credit-manager.js";
import { WalletManager } from "./wallet.js";

const log = createLogger("main");

function usage() {
  console.log(`Self-Refueling Research Agent (Orbio · Robinhood Chain)

Research:
  orbio-research "<topic>" [--steps N] [--no-chat]   run research, then enter follow-up chat
  orbio-research team "<topic>" [--workers N] [--steps N]
                                                      coordinator + N worker agents in parallel
  orbio-research team wallets [N]                     show derived worker wallet addresses
  orbio-research team transfer <worker#|0x…> <credit> credit.transfer unactivated CREDIT to a worker
  orbio-research team fund <worker#|0x…> [usdg]       buyAndActivate CREDIT into a worker's API balance
  orbio-research list                                 archived reports
  orbio-research show <id>                            print an archived report
  orbio-research ask <id> "<question>"                one follow-up question on a report
  orbio-research chat <id>                            interactive follow-up on a report
  orbio-research compare <idA> <idB>                  compare two reports
  orbio-research web [--port 3000]                    start the web UI

Credits:
  orbio-research balance            API balance + wallet USDG/CREDIT/gas + open asks
  orbio-research quote [usdg]       quote the order book without buying
  orbio-research route [usdg]       quote the order book AND the Uniswap route; show which one a refuel would use
  orbio-research refuel [usdg]      buy + activate now via the better venue (respects DRY_RUN)
  orbio-research activate <credit>  activate CREDIT already held in the wallet
  orbio-research models             list model ids from the gateway
  orbio-research rotate-key         derive key for epoch+1

Market (sell surplus CREDIT on the order book):
  orbio-research book                       best ask, depth, minimum order, fee
  orbio-research buy <usdg>                 buy CREDIT into the wallet without activating (inventory)
  orbio-research sell <credit> [price]      place an ask (price in USDG per CREDIT; default = policy price)
  orbio-research orders                     our open asks (remaining / filled)
  orbio-research cancel <orderId>           cancel one of our asks
  orbio-research market [--rounds N]        one maintenance round: settle fills → restock if cheap → list surplus

Options:
  --steps N     max research steps (default 8; per worker in team mode, default 2)
  --workers N   number of worker agents in team mode (default 3)
  --no-chat     skip the follow-up loop after research
  --mock        offline demo: fake balance, quotes and model output
  --dry-run     never send on-chain transactions (default from .env)
  --live        allow on-chain purchases
`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) return usage();

  const rt = await createRuntime({
    mock: args.includes("--mock") || process.env.MOCK === "true",
    live: args.includes("--live"),
    dryRun: args.includes("--dry-run"),
  });
  const svc = new ResearchService(rt);
  const { cfg, credit, llm, wallet, store, market } = rt;

  const valued = new Set(["--steps", "--port", "--workers", "--rounds"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""));
  const command = positional[0];

  if (command === "team") {
    const coordinator = new Coordinator(rt);
    const sub = positional[1];
    const resolveWorker = (w: string) =>
      /^0x[0-9a-fA-F]{40}$/.test(w) ? (w as `0x${string}`) : coordinator.workerWallets(Number(w))[Number(w) - 1]?.address;

    if (sub === "wallets") {
      for (const w of coordinator.workerWallets(positional[2] ? Number(positional[2]) : undefined)) console.log(`Agent ${w.index}: ${w.address}`);
      return;
    }
    if (sub === "transfer") {
      const to = resolveWorker(positional[2] ?? "");
      if (!to || !positional[3]) throw new Error("usage: team transfer <worker#|0x…> <credit>");
      console.log(`tx: ${await credit.transferCredit(to, Number(positional[3]))}`);
      return;
    }
    if (sub === "fund") {
      const to = resolveWorker(positional[2] ?? "");
      if (!to) throw new Error("usage: team fund <worker#|0x…> [usdg]");
      const usdg = positional[3] ? Number(positional[3]) : cfg.WORKER_FUND_USDG;
      const readBal = async () => {
        const idx = coordinator.workerWallets(8).findIndex((w) => w.address.toLowerCase() === to.toLowerCase());
        if (idx < 0) return 0;
        const ww = new WalletManager({ ...cfg, PRIVATE_KEY: deriveWorkerKey(cfg.PRIVATE_KEY, idx + 1) });
        return CreditManager.balanceForKey(cfg.ORBIO_API_BASE, await ww.ensureApiKey());
      };
      console.log(JSON.stringify(await credit.purchase(usdg, to, readBal), null, 2));
      return;
    }
    const topic = positional.slice(1).join(" ").trim();
    if (!topic) throw new Error('usage: team "<topic>" [--workers N] [--steps N]');
    const workers = Number(flag(args, "--workers") ?? cfg.WORKER_COUNT);
    const steps = flag(args, "--steps");
    const { record, markdown } = await svc.researchTeam(topic, workers, steps ? Number(steps) : undefined);
    console.log("\n" + markdown);
    if (!args.includes("--no-chat") && stdin.isTTY) await chatLoop(svc, record.id);
    return;
  }

  switch (command) {
    case "balance": {
      const [info, onchain, refuelGas] = await Promise.all([
        credit.getKeyInfo(),
        credit.walletBalances(),
        credit.refuelGasCost().catch(() => undefined),
      ]);
      console.log(`API balance : $${info.available.toFixed(4)} (used $${info.used.toFixed(4)})`);
      console.log(`Wallet USDG : ${onchain.usdg.toFixed(4)}`);
      console.log(`Wallet CREDIT (unactivated): ${onchain.credit.toFixed(4)}`);
      const gasNote = refuelGas ? ` (one approve+buyAndActivate ≈ ${refuelGas.toFixed(6)} ETH → ${Math.floor(onchain.eth / refuelGas)} refuel(s) affordable)` : "";
      console.log(`Wallet gas  : ${onchain.eth.toFixed(6)} ETH${gasNote}`);
      console.log(
        `Budget      : today ${rt.budget.spentToday.toFixed(4)} / ${cfg.MAX_SPEND_PER_DAY} USDG on-chain · per task ≤ ${cfg.MAX_SPEND_PER_TASK} USDG on-chain, ≤ $${cfg.MAX_API_SPEND_PER_TASK} API`,
      );
      if (market.trackedIds.length) {
        const open = await market.openOrders().catch(() => []);
        console.log(`Open asks   : ${open.length}${open.length ? " — " + open.map((o) => `${o.remaining.toFixed(4)} CREDIT @ ${o.price.toFixed(4)}`).join(", ") : ""}`);
      }
      return;
    }
    case "book": {
      const b = await credit.book();
      console.log(`Best ask    : ${b.bestPrice ? `${b.bestPrice.toFixed(4)} USDG/CREDIT (${((1 - b.bestPrice) * 100).toFixed(1)}% off)` : "none (empty book)"}`);
      console.log(`Depth       : ${b.depthCredit.toFixed(2)} CREDIT ≈ ${b.depthUsdg.toFixed(2)} USDG in ${b.openOrders} order(s)`);
      console.log(`Min order   : ${b.minOrder} CREDIT · price tick ${(b.priceTick / b.priceScale).toFixed(4)} · buyer fee ${b.feeBps} bps`);
      console.log(`Policy ask  : ${(CreditManager.choosePrice(b.bestPriceRaw, cfg.SELL_MIN_PRICE, b.priceScale, b.priceTick) / b.priceScale).toFixed(4)} USDG/CREDIT (floor ${cfg.SELL_MIN_PRICE})`);
      return;
    }
    case "buy": {
      if (!positional[1]) throw new Error("usage: buy <usdg>");
      console.log(JSON.stringify(await credit.buyHeld(Number(positional[1])), null, 2));
      return;
    }
    case "sell": {
      if (!positional[1]) throw new Error("usage: sell <credit> [price]");
      const b = await credit.book();
      const priceRaw = positional[2] ? Math.round(Number(positional[2]) * b.priceScale) : CreditManager.choosePrice(b.bestPriceRaw, cfg.SELL_MIN_PRICE, b.priceScale, b.priceTick);
      if (priceRaw % b.priceTick !== 0 || priceRaw <= 0 || priceRaw > b.priceScale) {
        throw new Error(`price must be a multiple of ${(b.priceTick / b.priceScale).toFixed(4)} and at most 1.0000 (got ${(priceRaw / b.priceScale).toFixed(4)})`);
      }
      const rec = await credit.sell(Number(positional[1]), priceRaw);
      market.track(rec);
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    case "orders": {
      const open = await market.openOrders();
      if (!open.length) return console.log("(no open asks)");
      for (const o of open) console.log(`${o.orderId}  ${o.remaining.toFixed(4)} CREDIT left @ ${o.price.toFixed(4)} USDG/CREDIT  (filled ${o.filled.toFixed(4)})`);
      return;
    }
    case "cancel": {
      if (!positional[1]) throw new Error("usage: cancel <orderId>");
      console.log(`tx: ${await credit.cancel(positional[1])}`);
      await market.openOrders().catch(() => []);
      return;
    }
    case "market": {
      const rounds = Number(flag(args, "--rounds") ?? 1);
      for (let i = 1; i <= rounds; i++) {
        if (rounds > 1) log.info(`Market round ${i}/${rounds}`);
        const r = await market.rebalance();
        const parts = [
          r.bought ? `bought ${r.bought.creditOut.toFixed(4)} CREDIT for ${r.bought.usdgSpent.toFixed(4)} USDG` : undefined,
          r.sold ? `listed ${r.sold.credit.toFixed(4)} CREDIT @ ${r.sold.price.toFixed(4)}${r.sold.orderId ? ` (order ${r.sold.orderId})` : ""}` : undefined,
          `${r.open.length} ask(s) open`,
          ...r.notes,
        ].filter(Boolean);
        console.log(parts.join(" · "));
      }
      return;
    }
    case "quote": {
      console.log(JSON.stringify(await credit.quote(positional[1] ? Number(positional[1]) : cfg.REFUEL_USDG), null, 2));
      return;
    }
    case "route": {
      const usdg = positional[1] ? Number(positional[1]) : cfg.REFUEL_USDG;
      const q = await credit.quote(usdg);
      console.log(`Order book : ${usdg} USDG → ${q.creditOut.toFixed(4)} CREDIT via ${q.fills} fill(s), price ${q.price.toFixed(4)} (${(q.discount * 100).toFixed(1)}% off)`);
      if (!credit.route) {
        console.log("Uniswap    : not configured (set UNISWAP_PATH and UNISWAP_QUOTER in .env)");
      } else {
        const alt = await credit.routeQuote(usdg);
        console.log(
          alt
            ? `Uniswap    : ${usdg} USDG → ${alt.creditOut.toFixed(4)} CREDIT via ${credit.route.describe()}, price ${alt.price.toFixed(4)} (${(alt.discount * 100).toFixed(1)}% off)${alt.gasEstimate ? `, ~${alt.gasEstimate} gas` : ""}`
            : `Uniswap    : ${credit.route.describe()} — quote failed (see log)`,
        );
        const pick = CreditManager.pickSource(q, alt, cfg.MIN_DISCOUNT);
        console.log(`Refuel via : ${pick ?? `neither (both below MIN_DISCOUNT ${cfg.MIN_DISCOUNT})`}`);
      }
      return;
    }
    case "refuel": {
      console.log(JSON.stringify(await credit.refuel(positional[1] ? Number(positional[1]) : cfg.REFUEL_USDG), null, 2));
      return;
    }
    case "activate": {
      if (!positional[1]) throw new Error("activate requires an amount");
      console.log(`tx: ${await credit.activateHeld(Number(positional[1]))}`);
      return;
    }
    case "models": {
      for (const id of await llm.listModels()) console.log(id);
      return;
    }
    case "rotate-key": {
      const { key, epoch } = await wallet.rotateApiKey();
      llm.setApiKey(key);
      await credit.getKeyInfo();
      console.log(`Rotated. New epoch ${epoch}. Update .env: ORBIO_KEY_EPOCH=${epoch}`);
      return;
    }
    case "list": {
      const rows = store.list();
      if (!rows.length) return console.log("(no reports yet)");
      for (const r of rows) {
        const cost = r.cost ? `$${r.cost.consumed.toFixed(4)}` : "-";
        const flag = r.status === "partial" ? "  [未完成]" : "";
        console.log(`${r.id}${flag}\n    ${r.topic}  ·  ${r.createdAt.slice(0, 16).replace("T", " ")}  ·  ${cost}  ·  追问 ${r.followups}`);
      }
      return;
    }
    case "show": {
      const md = store.markdown(positional[1] ?? "");
      if (!md) throw new Error(`report not found: ${positional[1]}`);
      console.log(md);
      return;
    }
    case "ask": {
      const [, id, ...q] = positional;
      if (!id || !q.length) throw new Error('usage: ask <id> "<question>"');
      console.log("\n" + (await svc.ask(id, q.join(" "))));
      return;
    }
    case "chat": {
      if (!positional[1]) throw new Error("usage: chat <id>");
      await chatLoop(svc, positional[1]);
      return;
    }
    case "compare": {
      const [, a, b] = positional;
      if (!a || !b) throw new Error("usage: compare <idA> <idB>");
      const { markdown, file } = await svc.compare(a, b);
      console.log("\n" + markdown);
      log.info(`Comparison saved to ${file}`);
      return;
    }
    case "web": {
      const port = Number(flag(args, "--port") ?? process.env.PORT ?? 3000);
      await startServer(svc, rt, port);
      return; // server keeps the process alive
    }
  }

  let topic = positional.join(" ").trim();
  if (!topic) {
    const rl = createInterface({ input: stdin, output: stdout });
    topic = (await rl.question("研究主题 > ")).trim();
    rl.close();
    if (!topic) return usage();
  }

  const steps = flag(args, "--steps");
  const { record, markdown } = await svc.research(topic, steps ? Number(steps) : undefined);
  console.log("\n" + markdown);

  if (!args.includes("--no-chat") && stdin.isTTY) {
    await chatLoop(svc, record.id);
  }
}

async function chatLoop(svc: ResearchService, reportId: string) {
  const rl = createInterface({ input: stdin, output: stdout });
  console.log(`\n进入追问模式（报告 ${reportId}）。输入问题回车；输入 exit 或直接回车退出。\n`);
  try {
    for (;;) {
      const q = (await rl.question("追问 > ")).trim();
      if (!q || q.toLowerCase() === "exit" || q.toLowerCase() === "quit") break;
      const answer = await svc.ask(reportId, q);
      console.log("\n" + answer.trim() + "\n");
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  const e = err as { shortMessage?: string; message?: string; stack?: string };
  // viem errors carry a one-line shortMessage; the full stack is only useful at debug level.
  log.error(e?.shortMessage ?? e?.message ?? String(err));
  if ((process.env.LOG_LEVEL ?? "info") === "debug" && e?.stack) log.error(e.stack);
  process.exit(1);
});
