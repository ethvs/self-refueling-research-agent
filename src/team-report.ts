import type { CreditManager } from "./credit-manager.js";
import type { ResearchOutcome } from "./research-agent.js";
import type { ReportCost } from "./store.js";
import type { TeamOutcome } from "./team.js";

export interface TeamReportMeta {
  creditBefore: number;
  creditAfter: number;
  model: { cheap: string; search: string; strong: string };
  address: string;
}

/** Render a team run as Markdown and as a ResearchOutcome-shaped record so it archives like a normal report. */
export function renderTeamReport(
  t: TeamOutcome,
  credit: CreditManager,
  meta: TeamReportMeta,
): { markdown: string; cost: ReportCost; outcome: ResearchOutcome } {
  const workerCalls = t.workers.reduce((s, w) => s + w.usage.calls, 0);
  const workerPrompt = t.workers.reduce((s, w) => s + w.usage.promptTokens, 0);
  const workerCompletion = t.workers.reduce((s, w) => s + w.usage.completionTokens, 0);
  const fundingRecords = credit.refuels.filter((r) => r.beneficiary);
  const fundedCredits = fundingRecords.filter((r) => !r.dryRun).reduce((s, r) => s + r.creditOut, 0);
  // With a shared key every worker reads the coordinator's balance, so counting their deltas again would double-book.
  const workerConsumed = t.sharedKey
    ? 0
    : t.workers.reduce((s, w) => s + Math.max(0, w.balanceBefore + w.funded.filter((f) => !f.dryRun).reduce((a, f) => a + f.creditOut, 0) - w.balanceAfter), 0);
  const coordinatorConsumed = Math.max(0, meta.creditBefore + credit.refuels.filter((r) => !r.beneficiary && !r.dryRun).reduce((s, r) => s + r.creditOut, 0) - meta.creditAfter);

  const cost: ReportCost = {
    calls: t.coordinatorUsage.calls + workerCalls,
    promptTokens: t.coordinatorUsage.promptTokens + workerPrompt,
    completionTokens: t.coordinatorUsage.completionTokens + workerCompletion,
    creditBefore: meta.creditBefore,
    creditAfter: meta.creditAfter,
    consumed: coordinatorConsumed + workerConsumed,
    refuels: credit.refuels.length,
    usdgSpent: credit.totalSpent(),
  };

  const durationSec = Math.round((Date.parse(t.finishedAt) - Date.parse(t.startedAt)) / 1000);
  const failedWorkers = t.workers.filter((w) => w.error);
  const allFailed = t.workers.length > 0 && failedWorkers.length === t.workers.length;
  const partial = allFailed || Boolean(t.synthesisFallback);
  const error = allFailed
    ? `所有工作 Agent 都失败了（${failedWorkers.map((w) => `Agent ${w.worker}: ${w.error}`).join("；")}）`
    : t.synthesisFallback
      ? `协调者汇总失败（${t.synthesisFallback}），以下为各 Agent 子报告的直接拼接`
      : undefined;
  const banner = partial ? `\n> ⚠️ **本次研究未完成**：${error}。完整日志见同名 \`.log\` 文件。\n` : "";

  const workerRows = t.workers
    .map(
      (w) =>
        `| ${w.worker} | \`${w.address.slice(0, 10)}…\` | ${w.topic} | ${w.usage.calls} | $${w.balanceBefore.toFixed(4)} → $${w.balanceAfter.toFixed(4)} | ${w.funded.length} | ${w.error ? "❌ " + w.error.slice(0, 60) : "✅"} |`,
    )
    .join("\n");

  const fundingRows =
    fundingRecords.length === 0
      ? "| – | – | – | – | – | – |"
      : fundingRecords
          .map(
            (r) =>
              `| ${r.at} | \`${r.beneficiary!.slice(0, 10)}…\` | ${r.usdgSpent.toFixed(4)} | ${r.creditOut.toFixed(4)} | ${(r.discount * 100).toFixed(1)}% | ${r.dryRun ? "dry-run" : r.txHash ?? "-"} |`,
          )
          .join("\n");

  const workerSections = t.workers
    .map((w) => {
      const steps = w.outcome.results
        .map((r) => `<details><summary>步骤 ${r.step}：${r.action}</summary>\n\n${r.output.trim()}\n\n</details>`)
        .join("\n\n");
      return `<details><summary><b>Agent ${w.worker}</b> · ${w.topic}${w.focus ? `（${w.focus}）` : ""}</summary>\n\n钱包 \`${w.address}\`\n\n${w.outcome.synthesis.trim()}\n\n${steps}\n\n</details>`;
    })
    .join("\n\n");

  const markdown = `# 研究报告：${t.topic}

> 由 Self-Refueling Research Agent **团队模式** 自动生成 · ${t.finishedAt} · 耗时 ${durationSec}s · 协调者 + ${t.workers.length} 个工作 Agent 并行${partial ? " · **未完成**" : ""}
${banner}
${t.synthesis.trim() || "（未生成汇总）"}

---

## 团队分工

| Agent | 钱包 | 子课题 | 调用 | API 余额 | 拨款次数 | 状态 |
|---|---|---|---|---|---|---|
${workerRows}

### 各 Agent 报告

${workerSections}

## CREDIT 成本

| 指标 | 值 |
|---|---|
| 模型调用次数 | ${cost.calls}（协调者 ${t.coordinatorUsage.calls} + 工作 Agent ${workerCalls}） |
| Prompt tokens | ${cost.promptTokens} |
| Completion tokens | ${cost.completionTokens} |
| 协调者 API 余额 | $${meta.creditBefore.toFixed(4)} → $${meta.creditAfter.toFixed(4)} |
| 工作 Agent 合计消耗（估算） | ${t.sharedKey ? "（共用协调者 Key，已计入协调者余额变化）" : `$${workerConsumed.toFixed(4)}`} |
| 拨给工作 Agent 的 CREDIT | ${fundedCredits.toFixed(4)}（${fundingRecords.length} 次） |
| 链上花费 USDG | ${credit.totalSpent().toFixed(4)} |
| 模型 | 规划 \`${meta.model.cheap}\` / 检索 \`${meta.model.search}\` / 汇总 \`${meta.model.strong}\` |
| 协调者钱包 | \`${meta.address}\` |

### 协调者拨款记录（buyAndActivate → beneficiary）

| 时间 | 工作 Agent | USDG 花费 | CREDIT 激活 | 折扣 | 交易 |
|---|---|---|---|---|---|
${fundingRows}
`;

  const outcome: ResearchOutcome = {
    topic: t.topic,
    plan: { steps: t.workers.map((w) => ({ step: w.worker, action: w.topic, expected_output: w.focus || "子课题研究报告" })) },
    results: t.workers.map((w) => ({
      step: w.worker,
      action: `Agent ${w.worker}：${w.topic}`,
      expected_output: w.focus,
      output: w.outcome.synthesis,
      refueledBefore: w.funded.length > 0,
    })),
    synthesis: t.synthesis,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    status: partial ? "partial" : "completed",
    error,
  };

  return { markdown, cost, outcome };
}
