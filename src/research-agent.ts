import { z } from "zod";
import { CONSTANTS } from "./config.js";
import type { CreditManager } from "./credit-manager.js";
import { isInsufficientBalance, type OrbioLLM } from "./llm.js";
import { createLogger } from "./logger.js";
import {
  COMPARE_SYSTEM,
  FOLLOWUP_SYSTEM,
  PLAN_SYSTEM,
  STEP_SYSTEM,
  SYNTHESIS_SYSTEM,
  compareUser,
  followUpUser,
  planUser,
  stepUser,
  synthesisUser,
} from "./prompts.js";
import type { ReportRecord } from "./store.js";

const log = createLogger("agent");

const PlanSchema = z.object({
  steps: z
    .array(
      z.object({
        step: z.number().int().positive(),
        action: z.string().min(3),
        expected_output: z.string().min(3),
      }),
    )
    .min(1)
    .max(CONSTANTS.MAX_PLAN_STEPS),
});
export type Plan = z.infer<typeof PlanSchema>;
export type PlanStep = Plan["steps"][number];

export interface StepResult extends PlanStep {
  output: string;
  refueledBefore: boolean;
}

export interface ResearchOutcome {
  topic: string;
  plan: Plan;
  results: StepResult[];
  synthesis: string;
  startedAt: string;
  finishedAt: string;
  /** "partial" when the run stopped early; `error` says why and the report is marked incomplete. */
  status: "completed" | "partial";
  error?: string;
}

/** Thrown when a run stops after the plan was made; `partial` carries every step finished so far. */
export class ResearchInterrupted extends Error {
  constructor(
    message: string,
    readonly partial: ResearchOutcome,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ResearchInterrupted";
  }
}

type CompleteOpts = Parameters<OrbioLLM["complete"]>[0];

export interface AgentOptions {
  maxSteps?: number;
  label?: string;
  synthesisTier?: "cheap" | "strong";
  /** USD of gateway spend allowed for this run (MAX_API_SPEND_PER_TASK); beyond it the run stops with a partial report. */
  apiSpendCap?: number;
}

/**
 * ResearchAgent — core loop:
 *  plan → execute steps (search model) → checkpoint every N steps → synthesize (strong model)
 *
 * A checkpoint reads the API balance once, books the spend since the last checkpoint against the
 * per-run cap, then refuels if the balance is below the threshold. If the gateway rejects a call
 * because the balance ran out between checkpoints, the agent refuels immediately and retries once.
 * Any failure after planning is rethrown as ResearchInterrupted so the caller can archive a partial report.
 */
export class ResearchAgent {
  private readonly tag: string;
  private lastBalance?: number;
  private apiSpent = 0;

  constructor(
    private readonly llm: OrbioLLM,
    private readonly credit: CreditManager,
    private readonly opts: AgentOptions = {},
  ) {
    this.tag = opts.label ? `[${opts.label}] ` : "";
  }

  /** Gateway spend observed during this run (USD), from balance drops between checkpoints. */
  get apiSpentThisRun(): number {
    return this.apiSpent;
  }

  async run(topic: string): Promise<ResearchOutcome> {
    const startedAt = new Date().toISOString();
    await this.checkpoint();

    const plan = await this.plan(topic);
    log.info(`${this.tag}Plan with ${plan.steps.length} steps`);
    plan.steps.forEach((s) => log.info(`${this.tag}  ${s.step}. ${s.action}`));

    const results: StepResult[] = [];
    try {
      for (const [i, step] of plan.steps.entries()) {
        let refueledBefore = false;
        if (i > 0 && i % CONSTANTS.BALANCE_CHECK_EVERY_N_STEPS === 0) {
          refueledBefore = await this.checkpoint();
        }
        log.info(`${this.tag}Executing step ${step.step}/${plan.steps.length}: ${step.action}`);
        const output = await this.executeStep(topic, step, results);
        results.push({ ...step, output, refueledBefore });
      }

      await this.checkpoint();
      log.info(`${this.tag}Synthesizing ${this.opts.synthesisTier === "cheap" ? "sub-report" : "final report with strong model"}`);
      const synthesis = await this.callLLM({
        system: SYNTHESIS_SYSTEM,
        user: synthesisUser(topic, results),
        tier: this.opts.synthesisTier ?? "strong",
        maxTokens: 3000,
      });

      return { topic, plan, results, synthesis, startedAt, finishedAt: new Date().toISOString(), status: "completed" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`${this.tag}Research stopped after ${results.length}/${plan.steps.length} step(s): ${message}`);
      throw new ResearchInterrupted(
        message,
        { topic, plan, results, synthesis: "", startedAt, finishedAt: new Date().toISOString(), status: "partial", error: message },
        err,
      );
    }
  }

  /** Answer a follow-up question grounded in an archived report. */
  async followUp(report: ReportRecord, question: string): Promise<string> {
    await this.credit.ensureFuel();
    return this.callLLM({
      system: FOLLOWUP_SYSTEM,
      user: followUpUser(report, report.followups, question),
      tier: "strong",
      maxTokens: 1500,
    });
  }

  /** Compare two archived reports (e.g. the same topic researched on different days). */
  async compare(a: ReportRecord, b: ReportRecord): Promise<string> {
    await this.credit.ensureFuel();
    log.info(`Comparing reports ${a.id} ↔ ${b.id}`);
    return this.callLLM({
      system: COMPARE_SYSTEM,
      user: compareUser(a, b),
      tier: "strong",
      maxTokens: 2500,
    });
  }

  /**
   * One balance read: book the spend since the last checkpoint against the cap, then refuel if low.
   * Returns true when a refuel happened.
   */
  private async checkpoint(): Promise<boolean> {
    const bal = await this.credit.getBalance();
    if (this.lastBalance !== undefined && bal < this.lastBalance) this.apiSpent += this.lastBalance - bal;
    this.lastBalance = bal;

    const cap = this.opts.apiSpendCap;
    if (cap !== undefined) {
      if (this.apiSpent > 0) log.info(`${this.tag}API spend this run: $${this.apiSpent.toFixed(4)} / cap $${cap}`);
      if (this.apiSpent > cap) {
        throw new Error(`API spend cap exceeded: $${this.apiSpent.toFixed(4)} > $${cap} (MAX_API_SPEND_PER_TASK)`);
      }
    }

    let refueled = false;
    try {
      refueled = await this.credit.ensureFuel(bal);
    } catch (err) {
      // Policy, budget or wallet refused the purchase: keep working on what is left.
      // If the gateway later rejects a call (402) we try once more, then stop with a partial report.
      log.warn(`${this.tag}Refuel refused (${err instanceof Error ? err.message : err}); continuing with $${bal.toFixed(4)}`);
    }
    if (refueled) this.lastBalance = await this.credit.getBalance().catch(() => bal);
    return refueled;
  }

  /** Model call that reacts to the gateway running dry between checkpoints: refuel now, retry once. */
  private async callLLM(opts: CompleteOpts): Promise<string> {
    try {
      return await this.llm.complete(opts);
    } catch (err) {
      if (!isInsufficientBalance(err)) throw err;
      log.warn(`${this.tag}Gateway reports the balance is exhausted; refueling now instead of waiting for the next checkpoint`);
      try {
        await this.credit.refuelNow();
      } catch (refuelErr) {
        const why = refuelErr instanceof Error ? refuelErr.message : String(refuelErr);
        throw new Error(`Gateway balance exhausted and refuel refused: ${why}`, { cause: err });
      }
      this.lastBalance = await this.credit.getBalance().catch(() => this.lastBalance);
      return this.llm.complete(opts);
    }
  }

  private async plan(topic: string): Promise<Plan> {
    const max = this.opts.maxSteps ?? CONSTANTS.MAX_PLAN_STEPS;
    let user = planUser(topic, max);
    let lastRaw = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const raw = await this.callLLM({
        system: PLAN_SYSTEM.replace("{max}", String(max)),
        user,
        tier: "cheap",
        json: true,
        maxTokens: 800,
      });
      const parsed = PlanSchema.safeParse(safeJson(raw));
      if (parsed.success) {
        const steps = parsed.data.steps.slice(0, max).map((s, i) => ({ ...s, step: i + 1 }));
        return { steps };
      }
      lastRaw = raw;
      log.warn(`${this.tag}Planner returned an invalid plan (attempt ${attempt}/2): ${parsed.error.issues[0]?.message ?? "not JSON"}`);
      user += `\n\n上一次输出不是合法的 JSON 计划。只输出一个 JSON 对象，格式 {"steps":[{"step":1,"action":"...","expected_output":"..."}]}，不要任何其他文字。`;
    }
    throw new Error(`Planner returned an invalid JSON plan twice: ${lastRaw.slice(0, 300)}`);
  }

  private async executeStep(topic: string, step: PlanStep, prior: StepResult[]): Promise<string> {
    const priorSummary = prior.map((r) => `- 步骤 ${r.step}: ${r.output.slice(0, 200).replace(/\n/g, " ")}…`).join("\n");
    return this.callLLM({
      system: STEP_SYSTEM,
      user: stepUser(topic, step, priorSummary),
      tier: "search",
      maxTokens: 1200,
    });
  }
}

function safeJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
    return undefined;
  }
}
