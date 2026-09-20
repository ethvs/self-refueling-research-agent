import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createLogger } from "./logger.js";

const log = createLogger("budget");
const STATE_FILE = ".agent-state.json";

interface State {
  day: string; // YYYY-MM-DD
  spentToday: number; // USDG
}

/**
 * BudgetGuard enforces two limits on on-chain spending (USDG):
 *  - per task
 *  - per calendar day (persisted across runs in .agent-state.json)
 */
export class BudgetGuard {
  private taskSpent = 0;
  private state: State;

  constructor(
    private readonly maxPerTask: number,
    private readonly maxPerDay: number,
    private readonly persist = true,
  ) {
    this.state = persist ? this.load() : { day: this.today(), spentToday: 0 };
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private load(): State {
    if (existsSync(STATE_FILE)) {
      try {
        const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
        if (s.day === this.today()) return s;
      } catch {
        /* ignore corrupt file */
      }
    }
    return { day: this.today(), spentToday: 0 };
  }

  private save() {
    if (!this.persist) return;
    writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  /** Call at the start of each research run so the per-task cap applies per run, not per process. */
  resetTask() {
    this.taskSpent = 0;
  }

  /** Throws if spending `usdg` would break either cap. */
  assertCanSpend(usdg: number) {
    if (this.state.day !== this.today()) this.state = { day: this.today(), spentToday: 0 };
    if (this.taskSpent + usdg > this.maxPerTask) {
      throw new Error(
        `Task budget exceeded: spent ${this.taskSpent.toFixed(4)} + ${usdg.toFixed(4)} > ${this.maxPerTask} USDG`,
      );
    }
    if (this.state.spentToday + usdg > this.maxPerDay) {
      throw new Error(
        `Daily budget exceeded: spent ${this.state.spentToday.toFixed(4)} + ${usdg.toFixed(4)} > ${this.maxPerDay} USDG`,
      );
    }
  }

  record(usdg: number) {
    this.taskSpent += usdg;
    this.state.spentToday += usdg;
    this.save();
    log.info(`Recorded spend ${usdg.toFixed(4)} USDG (task ${this.taskSpent.toFixed(4)}, day ${this.state.spentToday.toFixed(4)})`);
  }

  get spentThisTask() {
    return this.taskSpent;
  }
  get spentToday() {
    return this.state.spentToday;
  }
}
