export const PLAN_SYSTEM = `你是一个专业研究助手。根据用户主题，输出一个清晰的研究计划。
只输出 JSON 对象，格式：{"steps":[{"step":1,"action":"...","expected_output":"..."}]}。
要求：步骤之间逻辑递进，覆盖背景、现状、关键数据、争议/风险、结论；步骤数量 3 到 {max} 个；action 必须具体可执行。`;

export const STEP_SYSTEM = `根据当前步骤要求，联网检索并完成研究，返回简洁、有来源的结果。
只输出结果，不要多余解释。使用 Markdown，每个关键事实后用 [来源: 网址或机构名] 标注真实出处。
只写检索到的信息；检索不到的内容明确写"未找到公开资料"，绝不编造数字、日期或来源。`;

export const SYNTHESIS_SYSTEM = `你是资深研究分析师。基于给定的各步骤研究结果，撰写最终报告。
输出 Markdown，包含以下二级标题：摘要、详细分析、来源、结论。
"详细分析"按主题分小节；"来源"合并去重所有 [来源: ...] 标注和引用链接，保留原始网址；"结论"给出 3-5 条可操作判断。
只使用步骤结果中出现的事实，不要补充任何步骤结果里没有的数据；资料不足之处如实说明。`;

export function planUser(topic: string, maxSteps: number) {
  return `研究主题：${topic}\n最多 ${maxSteps} 个步骤。`;
}

export function stepUser(topic: string, step: { step: number; action: string; expected_output: string }, priorSummary: string) {
  return [
    `研究主题：${topic}`,
    `当前步骤 ${step.step}：${step.action}`,
    `期望输出：${step.expected_output}`,
    priorSummary ? `\n此前步骤要点（供参考，避免重复）：\n${priorSummary}` : "",
  ].join("\n");
}

export function synthesisUser(topic: string, results: { step: number; action: string; output: string }[]) {
  const body = results.map((r) => `### 步骤 ${r.step}：${r.action}\n${r.output}`).join("\n\n");
  return `研究主题：${topic}\n\n各步骤结果：\n\n${body}`;
}

export const FOLLOWUP_SYSTEM = `你是研究助理，负责回答用户对一份已完成研究报告的追问。
只依据报告正文和研究过程中的原始结果作答，引用时保留原有的 [来源: ...] 标注。
报告未覆盖的问题要明确说明"报告未涉及"，并建议一个可追加的研究步骤，不要编造。
使用 Markdown，简洁直接。`;

export function followUpUser(
  report: { topic: string; synthesis: string; steps: { step: number; action: string; output: string }[] },
  history: { question: string; answer: string }[],
  question: string,
) {
  const steps = report.steps.map((s) => `### 步骤 ${s.step}：${s.action}\n${s.output}`).join("\n\n");
  const hist = history.map((h) => `Q: ${h.question}\nA: ${h.answer}`).join("\n\n");
  return [
    `研究主题：${report.topic}`,
    `\n## 报告正文\n${report.synthesis}`,
    steps ? `\n## 研究过程原始结果\n${steps}` : "",
    hist ? `\n## 此前追问\n${hist}` : "",
    `\n## 当前追问\n${question}`,
  ].join("\n");
}

export const COMPARE_SYSTEM = `你是资深研究分析师，负责对比两份研究报告 A 和 B。
输出 Markdown，包含二级标题：共同结论、差异与矛盾、数据变化、可靠性评估、建议。
"数据变化"用表格列出同一指标在 A/B 中的数值；"可靠性评估"说明哪份来源更充分。
只依据两份报告的内容，不要补充外部信息。`;

export function compareUser(a: { topic: string; createdAt: string; synthesis: string }, b: { topic: string; createdAt: string; synthesis: string }) {
  return `## 报告 A（${a.createdAt}）：${a.topic}\n\n${a.synthesis}\n\n---\n\n## 报告 B（${b.createdAt}）：${b.topic}\n\n${b.synthesis}`;
}

// ===== Team mode =====

export function teamPlanSystem(n: number) {
  return `你是研究协调者。把用户的研究主题拆分为 ${n} 个互补的子课题，分配给 ${n} 个工作 Agent 并行研究。
只输出 JSON 对象：{"subtopics":[{"worker":1,"topic":"...","focus":"..."}]}。
要求：子课题之间不重叠、合起来覆盖主题的主要维度（如背景机制、现状数据、风险监管、竞争趋势）；topic 是可独立研究的完整表述，focus 一句话说明侧重点。`;
}

export function teamPlanUser(topic: string) {
  return `研究主题：${topic}`;
}

export const TEAM_SYNTHESIS_SYSTEM = `你是研究协调者，负责汇总多个工作 Agent 的研究报告，形成一份最终报告。
输出 Markdown，包含二级标题：摘要、详细分析、分工与来源、结论。
"详细分析"按主题整合各 Agent 的发现，指出相互印证或矛盾之处；"分工与来源"按 Agent 列出其子课题和主要来源（保留原始网址）；"结论"给出 3-5 条可操作判断。
只使用各 Agent 报告中出现的事实，不补充外部信息；资料不足处如实说明。`;

export function teamSynthesisUser(topic: string, reports: { worker: number; topic: string; synthesis: string }[]) {
  const body = reports.map((r) => `## Agent ${r.worker}：${r.topic}\n\n${r.synthesis}`).join("\n\n---\n\n");
  return `研究主题：${topic}\n\n${body}`;
}
