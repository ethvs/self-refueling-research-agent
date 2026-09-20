import { keccak256, encodePacked, type Address, type Hex } from "viem";
import { z } from "zod";
import { BudgetGuard } from "./budget.js";
import type { Config } from "./config.js";
import { CreditManager, type RefuelRecord } from "./credit-manager.js";
import { OrbioLLM } from "./llm.js";
import { createLogger } from "./logger.js";
import { MockCreditManager, MockLLM } from "./mock.js";
import { TEAM_SYNTHESIS_SYSTEM, teamPlanSystem, teamPlanUser, teamSynthesisUser } from "./prompts.js";
import { ResearchAgent, ResearchInterrupted, type ResearchOutcome } from "./research-agent.js";
import type { Runtime } from "./runtime.js";
import { WalletManager } from "./wallet.js";

const log = createLogger("team");

/**
 * Worker wallets are derived deterministically from the coordinator key:
 *   workerKey_i = keccak256(coordinatorKey ‖ i)
 * No file to store, workers are stable across runs, and knowing a worker key
 * does not reveal the coordinator key. Workers never hold USDG or gas: the
 * coordinator activates CREDIT straight into their API balance via
 * buyAndActivate(..., beneficiary = worker) / activate(amount, beneficiary).
 */
export function deriveWorkerKey(coordinatorKey: Hex, index: number): Hex {
  return keccak256(encodePacked(["bytes32", "uint256"], [coordinatorKey, BigInt(index)]));
}

const SubtopicsSchema = z.object({
  subtopics: z
    .array(z.object({ worker: z.number().int().positive(), topic: z.string().min(3), focus: z.string().default("") }))
    .min(1),
});

export interface WorkerOutcome {
  worker: number;
  address: Address;
  topic: string;
  focus: string;
  outcome: ResearchOutcome;
  usage: { calls: number; promptTokens: number; completionTokens: number };
  balanceBefore: number;
  balanceAfter: number;
  funded: RefuelRecord[];
  error?: string;
}

export interface TeamOutcome {
  topic: string;
  workers: WorkerOutcome[];
  synthesis: string;
  startedAt: string;
  finishedAt: string;
  coordinatorUsage: { calls: number; promptTokens: number; completionTokens: number };
  /** Set when the strong-model synthesis failed and `synthesis` is the concatenated worker reports instead. */
  synthesisFallback?: string;
  /** DRY RUN in real mode: workers used the coordinator's key, so their balance deltas are already in the coordinator's. */
  sharedKey?: boolean;
}

/** A worker's credit manager: reads its own API balance, asks the coordinator when low. */
class WorkerCredit extends CreditManager {
  readonly funded: RefuelRecord[] = [];
  constructor(
    cfg: Config,
    wallet: WalletManager,
    budget: BudgetGuard,
    private readonly coordinator: Coordinator,
    private readonly sharedKey: boolean,
  ) {
    super(cfg, wallet, budget);
  }

  override async ensureFuel(known?: number): Promise<boolean> {
    const bal = known ?? (await this.getBalance());
    const thr = this.coordinator.cfg.WORKER_LOW_THRESHOLD;
    log.info(`[${this.wallet.address.slice(0, 8)}] worker API balance: $${bal.toFixed(4)} (threshold $${thr})`);
    if (bal >= thr) return false;
    if (this.sharedKey) {
      log.warn("worker shares the coordinator key (DRY RUN); no funding attempted");
      return false;
    }
    try {
      const rec = await this.coordinator.fundWorker(this.wallet.address, () => this.getBalance());
      this.funded.push(rec);
      return true;
    } catch (e) {
      // Budget or order-book policy refused: keep working on the remaining balance; the gateway will stop us if it runs out.
      log.warn(`[${this.wallet.address.slice(0, 8)}] funding refused (${e instanceof Error ? e.message : e}); continuing with $${bal.toFixed(4)}`);
      return false;
    }
  }

  override async refuel(): Promise<RefuelRecord> {
    const rec = await this.coordinator.fundWorker(this.wallet.address, () => this.getBalance());
    this.funded.push(rec);
    return rec;
  }
}

export class Coordinator {
  readonly cfg: Config;
  private readonly mockWorkers = new Map<string, MockCreditManager>();

  constructor(private readonly rt: Runtime) {
    this.cfg = rt.cfg;
    if (rt.mock) {
      (rt.credit as MockCreditManager).fundHook = (addr, credits) => {
        const w = this.mockWorkers.get(addr.toLowerCase());
        if (w) w.balance += credits;
      };
    }
  }

  /** Addresses of the first `n` worker wallets (for display / manual transfers). */
  workerWallets(n = this.cfg.WORKER_COUNT): { index: number; address: Address }[] {
    return Array.from({ length: n }, (_, i) => ({
      index: i + 1,
      address: new WalletManager({ ...this.cfg, PRIVATE_KEY: deriveWorkerKey(this.cfg.PRIVATE_KEY, i + 1) }).address,
    }));
  }

  /**
   * Fund a worker's API balance. Prefers activating CREDIT the coordinator already holds
   * (only gas), otherwise buys from the order book with beneficiary = worker.
   * Goes through the coordinator's discount policy and budget guard.
   * Requests are serialized: parallel workers would otherwise race for the coordinator's nonce and allowance.
   */
  async fundWorker(worker: Address, readWorkerBalance: () => Promise<number>): Promise<RefuelRecord> {
    const run = this.fundQueue.then(() => this.fundWorkerNow(worker, readWorkerBalance));
    this.fundQueue = run.catch(() => undefined);
    return run;
  }

  private fundQueue: Promise<unknown> = Promise.resolve();

  private async fundWorkerNow(worker: Address, readWorkerBalance: () => Promise<number>): Promise<RefuelRecord> {
    const usdg = this.cfg.WORKER_FUND_USDG;
    log.warn(`Worker ${worker} below threshold → coordinator funding ${usdg} USDG worth of CREDIT`);
    if (!this.rt.mock) {
      const held = (await this.rt.credit.walletBalances().catch(() => ({ credit: 0 }))).credit;
      if (held >= usdg) {
        const hash = await this.rt.credit.activateHeld(usdg, worker);
        return {
          usdgSpent: 0,
          creditOut: usdg,
          price: 0,
          discount: 1,
          fills: 0,
          beneficiary: worker,
          txHash: hash,
          dryRun: this.cfg.DRY_RUN,
          at: new Date().toISOString(),
        };
      }
    }
    return this.rt.credit.purchase(usdg, worker, readWorkerBalance);
  }

  async run(topic: string, workerCount = this.cfg.WORKER_COUNT, stepsPerWorker = this.cfg.WORKER_STEPS): Promise<TeamOutcome> {
    const startedAt = new Date().toISOString();
    const { llm, credit, mock, budget, cfg } = this.rt;
    const usage0 = { ...llm.usage };

    await credit.ensureFuel();
    const subtopics = await this.split(topic, workerCount);
    log.info(`Coordinator split "${topic}" into ${subtopics.length} sub-topics`);
    subtopics.forEach((s) => log.info(`  Agent ${s.worker}: ${s.topic}`));

    // DRY RUN in real mode cannot fund workers on-chain, so they share the coordinator's key.
    const sharedKey = !mock && cfg.DRY_RUN;
    if (sharedKey) log.warn("DRY RUN: workers will share the coordinator API key. Use --live to fund worker wallets on-chain.");

    const workers = await Promise.all(
      subtopics.map(async (s) => {
        const workerCfg: Config = { ...cfg, PRIVATE_KEY: deriveWorkerKey(cfg.PRIVATE_KEY, s.worker) };
        const wallet = new WalletManager(workerCfg);
        const label = `w${s.worker}`;

        let wllm: OrbioLLM;
        let wcredit: CreditManager;
        if (mock) {
          const mc = new MockCreditManager(workerCfg, wallet, budget, cfg, 0);
          this.mockWorkers.set(wallet.address.toLowerCase(), mc);
          wcredit = new MockWorkerCredit(mc, this, workerCfg, wallet, budget);
          wllm = new MockLLM(workerCfg, mc);
        } else {
          await wallet.ensureApiKey();
          const key = sharedKey ? this.rt.wallet.getApiKey() : wallet.getApiKey();
          wllm = new OrbioLLM(cfg, key);
          const wc = new WorkerCredit(workerCfg, wallet, budget, this, sharedKey);
          if (sharedKey) wc.getBalance = () => credit.getBalance();
          wcredit = wc;
        }

        const balanceBefore = await wcredit.getBalance().catch(() => 0);
        const agent = new ResearchAgent(wllm, wcredit, { maxSteps: stepsPerWorker, label, synthesisTier: "cheap", apiSpendCap: cfg.MAX_API_SPEND_PER_TASK });
        log.info(`[${label}] ${wallet.address} starting: ${s.topic}`);
        let outcome: ResearchOutcome;
        let error: string | undefined;
        try {
          outcome = await agent.run(s.topic);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
          log.error(`[${label}] failed: ${error}`);
          // Keep whatever steps the worker finished so the team report (and the coordinator) can still use them.
          const partial = e instanceof ResearchInterrupted ? e.partial : undefined;
          outcome = {
            topic: s.topic,
            plan: partial?.plan ?? { steps: [] },
            results: partial?.results ?? [],
            synthesis: partial?.results.length
              ? `（Agent ${s.worker} 未完成：${error}。以下为已完成的 ${partial!.results.length} 步原始结果）\n\n` +
                partial!.results.map((r) => `### 步骤 ${r.step}：${r.action}\n${r.output}`).join("\n\n")
              : `（Agent ${s.worker} 执行失败：${error}）`,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "partial",
            error,
          };
        }
        const balanceAfter = await wcredit.getBalance().catch(() => balanceBefore);
        const funded = wcredit instanceof WorkerCredit ? wcredit.funded : (wcredit as MockWorkerCredit).funded;
        return {
          worker: s.worker,
          address: wallet.address,
          topic: s.topic,
          focus: s.focus,
          outcome,
          usage: { ...wllm.usage },
          balanceBefore,
          balanceAfter,
          funded,
          error,
        } satisfies WorkerOutcome;
      }),
    );

    await credit.ensureFuel();
    const successful = workers.filter((w) => !w.error);
    let synthesis: string;
    let synthesisFallback: string | undefined;
    if (successful.length === 0) {
      synthesisFallback = "没有可汇总的子报告";
      synthesis = workers.map((w) => `## Agent ${w.worker}：${w.topic}\n\n${w.outcome.synthesis}`).join("\n\n---\n\n");
      log.error("All workers failed; skipping coordinator synthesis");
    } else {
      log.info("Coordinator synthesizing team report with strong model");
      try {
        synthesis = await llm.complete({
          system: TEAM_SYNTHESIS_SYSTEM,
          user: teamSynthesisUser(
            topic,
            workers.map((w) => ({ worker: w.worker, topic: w.topic, synthesis: w.outcome.synthesis })),
          ),
          tier: "strong",
          maxTokens: 3500,
        });
      } catch (e) {
        // The workers' reports are already in hand; never lose them because the final call failed.
        synthesisFallback = e instanceof Error ? e.message : String(e);
        log.error(`Coordinator synthesis failed (${synthesisFallback}); falling back to concatenated worker reports`);
        synthesis = workers.map((w) => `## Agent ${w.worker}：${w.topic}\n\n${w.outcome.synthesis}`).join("\n\n---\n\n");
      }
    }

    return {
      topic,
      workers,
      synthesis,
      synthesisFallback,
      sharedKey,
      startedAt,
      finishedAt: new Date().toISOString(),
      coordinatorUsage: {
        calls: llm.usage.calls - usage0.calls,
        promptTokens: llm.usage.promptTokens - usage0.promptTokens,
        completionTokens: llm.usage.completionTokens - usage0.completionTokens,
      },
    };
  }

  private async split(topic: string, n: number) {
    let user = teamPlanUser(topic);
    let lastRaw = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const raw = await this.rt.llm.complete({
        system: teamPlanSystem(n),
        user,
        tier: "cheap",
        json: true,
        maxTokens: 700,
      });
      const parsed = SubtopicsSchema.safeParse(safeJson(raw));
      if (parsed.success) return parsed.data.subtopics.slice(0, n).map((s, i) => ({ ...s, worker: i + 1 }));
      lastRaw = raw;
      log.warn(`Coordinator returned invalid sub-topic JSON (attempt ${attempt}/2): ${parsed.error.issues[0]?.message ?? "not JSON"}`);
      user += `\n\n上一次输出不是合法的 JSON。只输出一个 JSON 对象，格式 {"subtopics":[{"worker":1,"topic":"...","focus":"..."}]}，不要任何其他文字。`;
    }
    throw new Error(`Coordinator returned invalid sub-topic JSON twice: ${lastRaw.slice(0, 300)}`);
  }
}

/** Mock worker: balance lives in the MockCreditManager; funding is routed through the coordinator. */
class MockWorkerCredit extends CreditManager {
  readonly funded: RefuelRecord[] = [];
  constructor(
    private readonly inner: MockCreditManager,
    private readonly coordinator: Coordinator,
    cfg: Config,
    wallet: WalletManager,
    budget: BudgetGuard,
  ) {
    super(cfg, wallet, budget);
  }
  override async getBalance() {
    return this.inner.balance;
  }
  override async getKeyInfo() {
    return this.inner.getKeyInfo();
  }
  override async ensureFuel(known?: number): Promise<boolean> {
    const bal = known ?? this.inner.balance;
    const thr = this.coordinator.cfg.WORKER_LOW_THRESHOLD;
    log.info(`[${this.wallet.address.slice(0, 8)}] worker API balance: $${bal.toFixed(4)} (threshold $${thr})`);
    if (bal >= thr) return false;
    try {
      this.funded.push(await this.coordinator.fundWorker(this.wallet.address, () => this.getBalance()));
      return true;
    } catch (e) {
      log.warn(`[${this.wallet.address.slice(0, 8)}] funding refused (${e instanceof Error ? e.message : e}); continuing with $${bal.toFixed(4)}`);
      return false;
    }
  }
  /** Mid-task refuel (gateway said the balance is exhausted) also goes through the coordinator. */
  override async refuel(): Promise<RefuelRecord> {
    const rec = await this.coordinator.fundWorker(this.wallet.address, () => this.getBalance());
    this.funded.push(rec);
    return rec;
  }
}

function safeJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const s = t.indexOf("{");
    const e = t.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(t.slice(s, e + 1));
      } catch {
        /* ignore */
      }
    }
    return undefined;
  }
}
