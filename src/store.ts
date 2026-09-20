import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ResearchOutcome } from "./research-agent.js";

export interface ReportCost {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  creditBefore: number;
  creditAfter: number;
  consumed: number;
  refuels: number;
  usdgSpent: number;
}

export interface FollowUp {
  question: string;
  answer: string;
  at: string;
}

export interface ReportRecord {
  id: string;
  topic: string;
  createdAt: string;
  file: string;
  cost?: ReportCost;
  synthesis: string;
  steps: { step: number; action: string; output: string }[];
  followups: FollowUp[];
  /** "partial" when the run stopped early (budget cap, gateway error, …); see `error`. */
  status?: "completed" | "partial";
  error?: string;
  /** Full run log archived next to the report (<id>.log). */
  logFile?: string;
}

export type ReportSummary = Pick<ReportRecord, "id" | "topic" | "createdAt" | "cost" | "status"> & { followups: number };

/**
 * ReportStore — every research run is archived as
 *   <id>.md    human-readable report (what the CLI prints)
 *   <id>.json  structured record (used for list / compare / follow-up)
 *   <id>.log   the run's log lines (saved by the service after the run)
 * Older .md-only reports are still listed (title parsed from the first line).
 */
export class ReportStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  save(outcome: ResearchOutcome, markdown: string, cost: ReportCost): ReportRecord {
    const id = makeId(outcome.topic);
    const file = join(this.dir, `${id}.md`);
    writeFileSync(file, markdown, "utf8");
    const record: ReportRecord = {
      id,
      topic: outcome.topic,
      createdAt: outcome.finishedAt,
      file,
      cost,
      synthesis: outcome.synthesis,
      steps: outcome.results.map((r) => ({ step: r.step, action: r.action, output: r.output })),
      followups: [],
      status: outcome.status,
      error: outcome.error,
    };
    this.writeJson(record);
    return record;
  }

  /** Archive the run log next to the report and remember it in the record. */
  saveLog(id: string, lines: string[]): string {
    const rec = this.get(id);
    if (!rec) throw new Error(`report not found: ${id}`);
    const file = join(this.dir, `${rec.id}.log`);
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    rec.logFile = file;
    this.writeJson(rec);
    return file;
  }

  log(id: string): string | undefined {
    const file = join(this.dir, `${sanitizeId(id)}.log`);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }

  list(): ReportSummary[] {
    if (!existsSync(this.dir)) return [];
    const out: ReportSummary[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".md") || f.startsWith("compare_")) continue;
      const id = basename(f, ".md");
      const rec = this.readJson(id);
      if (rec) {
        out.push({ id, topic: rec.topic, createdAt: rec.createdAt, cost: rec.cost, status: rec.status, followups: rec.followups.length });
      } else {
        const md = readFileSync(join(this.dir, f), "utf8");
        const topic = /^# 研究报告：(.+)$/m.exec(md)?.[1]?.trim() ?? id;
        out.push({ id, topic, createdAt: statSync(join(this.dir, f)).mtime.toISOString(), followups: 0 });
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(id: string): ReportRecord | undefined {
    const safe = sanitizeId(id);
    const rec = this.readJson(safe);
    if (rec) return rec;
    const file = join(this.dir, `${safe}.md`);
    if (!existsSync(file)) return undefined;
    const md = readFileSync(file, "utf8");
    return {
      id: safe,
      topic: /^# 研究报告：(.+)$/m.exec(md)?.[1]?.trim() ?? safe,
      createdAt: statSync(file).mtime.toISOString(),
      file,
      synthesis: md,
      steps: [],
      followups: [],
    };
  }

  markdown(id: string): string | undefined {
    const file = join(this.dir, `${sanitizeId(id)}.md`);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }

  addFollowUp(id: string, question: string, answer: string): FollowUp {
    const rec = this.get(id);
    if (!rec) throw new Error(`report not found: ${id}`);
    const fu: FollowUp = { question, answer, at: new Date().toISOString() };
    rec.followups.push(fu);
    this.writeJson(rec);
    const md = this.markdown(id) ?? "";
    const header = md.includes("\n## 追问\n") ? "" : "\n\n## 追问\n";
    appendFileSync(rec.file, `${header}\n### Q: ${question}\n\n${answer.trim()}\n\n<sub>${fu.at}</sub>\n`, "utf8");
    return fu;
  }

  saveComparison(a: ReportRecord, b: ReportRecord, markdown: string): string {
    const id = `compare_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    const file = join(this.dir, `${id}.md`);
    writeFileSync(file, `# 报告对比\n\n- A: ${a.topic} (${a.id})\n- B: ${b.topic} (${b.id})\n\n${markdown.trim()}\n`, "utf8");
    return file;
  }

  private jsonPath(id: string) {
    return join(this.dir, `${id}.json`);
  }
  private readJson(id: string): ReportRecord | undefined {
    const p = this.jsonPath(id);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as ReportRecord;
    } catch {
      return undefined;
    }
  }
  private writeJson(rec: ReportRecord) {
    writeFileSync(this.jsonPath(rec.id), JSON.stringify(rec, null, 2), "utf8");
  }
}

function makeId(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${stamp}_${slug || "report"}`;
}

function sanitizeId(id: string): string {
  return basename(id).replace(/\.(md|json)$/, "");
}
