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
  orbio-research balance            API balance + wallet USDG/CREDIT/gas
  orbio-research quote [usdg]       quote the order book without buying
  orbio-research refuel [usdg]      buyAndActivate now (respects DRY_RUN)
  orbio-research activate <credit>  activate CREDIT already held in the wallet
  orbio-research models             list model ids from the gateway
  orbio-research rotate-key         derive key for epoch+1

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
  const { cfg, credit, llm, wallet, store } = rt;

  const valued = new Set(["--steps", "--port", "--workers"]);
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
      return;
    }
    case "quote": {
      console.log(JSON.stringify(await credit.quote(positional[1] ? Number(positional[1]) : cfg.REFUEL_USDG), null, 2));
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
