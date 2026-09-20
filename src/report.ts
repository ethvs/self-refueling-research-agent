import type { CreditManager } from "./credit-manager.js";
import type { Usage } from "./llm.js";
import type { ResearchOutcome } from "./research-agent.js";
import type { ReportCost } from "./store.js";

export interface ReportMeta {
  creditBefore: number; // USD API balance at start
  creditAfter: number;
  usage: Usage;
  model: { cheap: string; search: string; strong: string };
  address: string;
}

export function renderReport(outcome: ResearchOutcome, credit: CreditManager, meta: ReportMeta): { markdown: string; cost: ReportCost } {
  const activated = credit.refuels.reduce((s, r) => (r.dryRun ? s : s + r.creditOut), 0);
  const consumed = Math.max(0, meta.creditBefore + activated - meta.creditAfter);
  const cost: ReportCost = {
    calls: meta.usage.calls,
    promptTokens: meta.usage.promptTokens,
    completionTokens: meta.usage.completionTokens,
    creditBefore: meta.creditBefore,
    creditAfter: meta.creditAfter,
    consumed,
    refuels: credit.refuels.length,
    usdgSpent: credit.totalSpent(),
  };
  const refuelRows =
    credit.refuels.length === 0
      ? "| – | – | – | – | – | – |"
      : credit.refuels
          .map(
            (r) =>
              `| ${r.at} | ${r.usdgSpent.toFixed(4)} | ${r.creditOut.toFixed(4)} | ${(r.discount * 100).toFixed(1)}% | ${r.fills} | ${r.dryRun ? "dry-run" : r.txHash ?? "-"} |`,
          )
          .join("\n");

  const durationSec = Math.round((Date.parse(outcome.finishedAt) - Date.parse(outcome.startedAt)) / 1000);
  const partial = outcome.status === "partial";
  const banner = partial
    ? `\n> ⚠️ **本次研究未完成**：${outcome.error ?? "未知原因"}。已完成 ${outcome.results.length}/${outcome.plan.steps.length || "?"} 步，以下为部分结果；完整日志见同名 \`.log\` 文件。\n`
    : "";
  const body = outcome.synthesis.trim() || "（未生成总结）";

  const markdown = `# 研究报告：${outcome.topic}

> 由 Self-Refueling Research Agent 自动生成 · ${outcome.finishedAt} · 耗时 ${durationSec}s${partial ? " · **未完成**" : ""}
${banner}
${body}

---

## 研究过程

${
  outcome.results.length === 0
    ? "（没有完成任何步骤）"
    : outcome.results
        .map(
          (r) =>
            `<details><summary>步骤 ${r.step}：${r.action}${r.refueledBefore ? " ⛽ (执行前已自动补充 CREDIT)" : ""}</summary>\n\n${r.output.trim()}\n\n</details>`,
        )
        .join("\n\n")
}

## CREDIT 成本

| 指标 | 值 |
|---|---|
| 模型调用次数 | ${meta.usage.calls} |
| Prompt tokens | ${meta.usage.promptTokens} |
| Completion tokens | ${meta.usage.completionTokens} |
| 开始时 API 余额 | $${meta.creditBefore.toFixed(4)} |
| 结束时 API 余额 | $${meta.creditAfter.toFixed(4)} |
| 本次消耗（估算） | $${consumed.toFixed(4)} |
| 自动购买次数 | ${credit.refuels.length} |
| 链上花费 USDG | ${credit.totalSpent().toFixed(4)} |
| 模型 | 规划 \`${meta.model.cheap}\` / 检索 \`${meta.model.search}\` / 总结 \`${meta.model.strong}\` |
| Agent 钱包 | \`${meta.address}\` |

### 自动续费记录

| 时间 | USDG 花费 | CREDIT 激活 | 折扣 | 成交笔数 | 交易 |
|---|---|---|---|---|---|
${refuelRows}
`;
  return { markdown, cost };
}
