import { renderReport } from "./report.js";
import { renderTeamReport } from "./team-report.js";
import { Coordinator } from "./team.js";
import { ResearchAgent, ResearchInterrupted, type ResearchOutcome } from "./research-agent.js";
import type { Runtime } from "./runtime.js";
import type { ReportRecord } from "./store.js";
import { captureLogs, createLogger } from "./logger.js";
import type { Usage } from "./llm.js";

const log = createLogger("service");

/**
 * High-level operations shared by the CLI and the web server.
 * Each call creates its own ResearchAgent; token usage is reset per run.
 * Every run — finished or not — is archived as <id>.md + <id>.json + <id>.log.
 */
export class ResearchService {
  private busy = false;

  constructor(private readonly rt: Runtime) {}

  get isBusy() {
    return this.busy;
  }

  async research(topic: string, maxSteps?: number, workers?: number): Promise<{ record: ReportRecord; markdown: string }> {
    if (this.busy) throw new Error("another research run is in progress");
    if (workers && workers > 1) return this.researchTeam(topic, workers, maxSteps);
    this.busy = true;
    const { cfg, credit, llm, store, budget } = this.rt;
    budget.resetTask();
    const startedAt = new Date().toISOString();
    const usageStart = { ...llm.usage };
    const capture = captureLogs();
    let creditBefore = 0;

    const archive = async (outcome: ResearchOutcome) => {
      const creditAfter = await credit.getBalance().catch(() => creditBefore);
      const { markdown, cost } = renderReport(outcome, credit, {
        creditBefore,
        creditAfter,
        usage: usageDelta(llm.usage, usageStart),
        model: { cheap: cfg.CHEAP_MODEL, search: cfg.SEARCH_MODEL, strong: cfg.STRONG_MODEL },
        address: this.rt.wallet.address,
      });
      const record = store.save(outcome, markdown, cost);
      log.info(`${outcome.status === "partial" ? "Partial report" : "Report"} saved to ${record.file}`);
      log.info(
        `Summary: ${cost.calls} calls, $${creditBefore.toFixed(4)} → $${creditAfter.toFixed(4)}, ${credit.refuels.length} refuel(s), ${credit.totalSpent().toFixed(4)} USDG spent`,
      );
      store.saveLog(record.id, capture.lines);
      return { record, markdown };
    };

    try {
      creditBefore = await credit.getBalance();
      const agent = new ResearchAgent(llm, credit, { maxSteps, apiSpendCap: cfg.MAX_API_SPEND_PER_TASK });
      const result = await archive(await agent.run(topic));
      await this.afterRun();
      return result;
    } catch (err) {
      // Keep every finished step and the full log so nothing paid for is lost.
      const partial = err instanceof ResearchInterrupted ? err.partial : emptyOutcome(topic, startedAt, err);
      await archive(partial).catch((e) => log.error(`could not save partial report: ${e instanceof Error ? e.message : e}`));
      throw err;
    } finally {
      capture.stop();
      this.busy = false;
    }
  }

  /** Coordinator + N worker agents researching complementary sub-topics in parallel. */
  async researchTeam(topic: string, workers: number, stepsPerWorker?: number): Promise<{ record: ReportRecord; markdown: string }> {
    if (this.busy) throw new Error("another research run is in progress");
    this.busy = true;
    const { cfg, credit, llm, wallet, store, budget } = this.rt;
    budget.resetTask();
    const startedAt = new Date().toISOString();
    const usageStart = { ...llm.usage };
    const capture = captureLogs();
    const model = { cheap: cfg.CHEAP_MODEL, search: cfg.SEARCH_MODEL, strong: cfg.STRONG_MODEL };
    let creditBefore = 0;
    try {
      creditBefore = await credit.getBalance();
      const coordinator = new Coordinator(this.rt);
      const team = await coordinator.run(topic, workers, stepsPerWorker);
      const creditAfter = await credit.getBalance().catch(() => creditBefore);
      const { markdown, cost, outcome } = renderTeamReport(team, credit, { creditBefore, creditAfter, model, address: wallet.address });
      const record = store.save(outcome, markdown, cost);
      log.info(`${outcome.status === "partial" ? "Partial team report" : "Team report"} saved to ${record.file}`);
      log.info(
        `Team summary: ${cost.calls} calls, ${team.workers.length} workers, ${credit.refuels.filter((r) => r.beneficiary).length} worker funding(s), ${credit.totalSpent().toFixed(4)} USDG spent`,
      );
      store.saveLog(record.id, capture.lines);
      await this.afterRun();
      return { record, markdown };
    } catch (err) {
      // Coordinator-level failure (split, funding, balance read): archive the log under an empty report.
      try {
        const outcome = emptyOutcome(topic, startedAt, err);
        const creditAfter = await credit.getBalance().catch(() => creditBefore);
        const { markdown, cost } = renderReport(outcome, credit, {
          creditBefore,
          creditAfter,
          usage: usageDelta(llm.usage, usageStart),
          model,
          address: wallet.address,
        });
        const record = store.save(outcome, markdown, cost);
        log.error(`Team run failed; partial report saved to ${record.file}`);
        store.saveLog(record.id, capture.lines);
      } catch (e) {
        log.error(`could not save partial report: ${e instanceof Error ? e.message : e}`);
      }
      throw err;
    } finally {
      capture.stop();
      this.busy = false;
    }
  }

  /** Market-maker maintenance after a successful run; policy refusals are logged, never thrown. */
  private async afterRun() {
    if (!this.rt.cfg.MARKET_MAKER) return;
    try {
      await this.rt.market.rebalance();
    } catch (err) {
      log.warn(`market maker skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async ask(reportId: string, question: string): Promise<string> {
    const rec = this.rt.store.get(reportId);
    if (!rec) throw new Error(`report not found: ${reportId}`);
    const agent = new ResearchAgent(this.rt.llm, this.rt.credit);
    const answer = await agent.followUp(rec, question);
    this.rt.store.addFollowUp(rec.id, question, answer);
    return answer;
  }

  async compare(idA: string, idB: string): Promise<{ markdown: string; file: string }> {
    const a = this.rt.store.get(idA);
    const b = this.rt.store.get(idB);
    if (!a || !b) throw new Error(`report not found: ${!a ? idA : idB}`);
    const agent = new ResearchAgent(this.rt.llm, this.rt.credit);
    const markdown = await agent.compare(a, b);
    const file = this.rt.store.saveComparison(a, b, markdown);
    log.info(`Comparison saved to ${file}`);
    return { markdown, file };
  }

  async status() {
    const { credit, wallet, mode, cfg, budget, market } = this.rt;
    const [info, onchain, book, open] = await Promise.all([
      credit.getKeyInfo(),
      credit.walletBalances().catch(() => null),
      cfg.MARKET_MAKER ? credit.book().catch(() => null) : Promise.resolve(null),
      cfg.MARKET_MAKER ? market.openOrders().catch(() => []) : Promise.resolve([]),
    ]);
    return {
      mode,
      address: wallet.address,
      chainId: cfg.CHAIN_ID,
      apiBalance: info.available,
      apiUsed: info.used,
      wallet: onchain,
      threshold: cfg.CREDIT_LOW_THRESHOLD,
      refuelUsdg: cfg.REFUEL_USDG,
      minDiscount: cfg.MIN_DISCOUNT,
      models: { cheap: cfg.CHEAP_MODEL, search: cfg.SEARCH_MODEL, strong: cfg.STRONG_MODEL },
      refuels: credit.refuels,
      team: { workers: cfg.WORKER_COUNT, steps: cfg.WORKER_STEPS, threshold: cfg.WORKER_LOW_THRESHOLD, fundUsdg: cfg.WORKER_FUND_USDG },
      budget: {
        taskSpent: budget.spentThisTask,
        taskCap: cfg.MAX_SPEND_PER_TASK,
        daySpent: budget.spentToday,
        dayCap: cfg.MAX_SPEND_PER_DAY,
        apiCapPerTask: cfg.MAX_API_SPEND_PER_TASK,
      },
      market: {
        enabled: cfg.MARKET_MAKER,
        reserve: cfg.CREDIT_RESERVE,
        sellMinPrice: cfg.SELL_MIN_PRICE,
        inventoryUsdg: cfg.INVENTORY_USDG,
        bestAsk: book?.bestPrice ?? null,
        openAsks: open.map((o) => ({ orderId: o.orderId, remaining: o.remaining, filled: o.filled, price: o.price })),
        sells: credit.sells,
      },
      route: credit.route ? { name: credit.route.name, path: credit.route.describe() } : null,
      busy: this.busy,
    };
  }
}

function usageDelta(now: Usage, start: Usage): Usage {
  return {
    calls: now.calls - start.calls,
    promptTokens: now.promptTokens - start.promptTokens,
    completionTokens: now.completionTokens - start.completionTokens,
  };
}

function emptyOutcome(topic: string, startedAt: string, err: unknown): ResearchOutcome {
  return {
    topic,
    plan: { steps: [] },
    results: [],
    synthesis: "",
    startedAt,
    finishedAt: new Date().toISOString(),
    status: "partial",
    error: err instanceof Error ? err.message : String(err),
  };
}
