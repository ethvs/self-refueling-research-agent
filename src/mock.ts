import type { Config } from "./config.js";
import { CreditManager, type KeyInfo, type Quote, type RefuelRecord } from "./credit-manager.js";
import { OrbioLLM } from "./llm.js";
import { createLogger } from "./logger.js";
import type { BudgetGuard } from "./budget.js";
import type { WalletManager } from "./wallet.js";
import { sleep } from "./retry.js";

const log = createLogger("mock");

/**
 * Mock mode: no network, no chain, no real API key.
 *  - MockCreditManager keeps an in-memory USD balance and a fixed order-book price.
 *  - MockLLM returns canned plan / step / synthesis text and charges the mock balance,
 *    so the balance visibly drops and triggers the refuel path mid-run.
 */

export const MOCK_COST_PER_CALL = 0.015; // USD per cheap call (≈ real gpt-4o-mini/sonar cost); strong calls cost double
export const MOCK_PRICE = 0.82; // USDG per CREDIT (18% discount)
export const MOCK_FEE_BPS = 0;

export class MockCreditManager extends CreditManager {
  /** Starts just above the threshold so a 3-step run triggers exactly one refuel before step 3. */
  readonly startBalance: number;
  balance: number;
  private txCounter = 0;

  constructor(
    cfg: Config,
    wallet: WalletManager,
    private readonly budgetGuard: BudgetGuard,
    private readonly mockCfg: Config = cfg,
    startBalance?: number,
  ) {
    super(cfg, wallet, budgetGuard);
    this.startBalance = startBalance ?? cfg.CREDIT_LOW_THRESHOLD + 0.04;
    this.balance = this.startBalance;
  }

  charge(usd: number) {
    this.balance = Math.max(0, this.balance - usd);
  }

  override async getKeyInfo(): Promise<KeyInfo> {
    return {
      available: this.balance,
      used: this.startBalance - this.balance,
      rateLimit: { requests_per_minute: 120, concurrent: 32 },
    };
  }

  override async getBalance(): Promise<number> {
    return this.balance;
  }

  override async walletBalances() {
    return { usdg: 25, credit: 0, eth: 0.01 };
  }

  override async quote(usdgIn: number, maxFills = this.mockCfg.MAX_FILLS): Promise<Quote> {
    await sleep(150);
    const fee = (usdgIn * MOCK_FEE_BPS) / 10_000;
    const spent = usdgIn - fee;
    const creditOut = spent / MOCK_PRICE;
    const price = usdgIn / creditOut;
    return {
      usdgIn,
      creditOut,
      usdgSpent: spent,
      feeAtoms: fee,
      fills: Math.min(2, maxFills),
      reason: 0,
      price,
      discount: 1 - price,
    };
  }

  /** Coordinator hook: credit a worker's mock balance when purchase() targets another wallet. */
  fundHook?: (beneficiary: string, credits: number) => void;

  override async refuel(usdgIn: number): Promise<RefuelRecord> {
    return this.purchase(usdgIn, this.wallet.address, () => this.getBalance());
  }

  override async purchase(usdgIn: number, beneficiary: `0x${string}`, _readBalance?: () => Promise<number>): Promise<RefuelRecord> {
    const q = await this.quote(usdgIn);
    const forSelf = beneficiary.toLowerCase() === this.wallet.address.toLowerCase();
    log.info(
      `[mock] Quote: ${usdgIn} USDG → ${q.creditOut.toFixed(4)} CREDIT via ${q.fills} fill(s), price ${q.price.toFixed(4)} (${(q.discount * 100).toFixed(1)}% off)${forSelf ? "" : ` for ${beneficiary}`}`,
    );
    if (!CreditManager.acceptable(q, this.mockCfg.MIN_DISCOUNT)) {
      throw new Error(`[mock] discount ${(q.discount * 100).toFixed(1)}% below policy`);
    }
    const cost = q.usdgSpent + q.feeAtoms;
    this.budgetGuard.assertCanSpend(cost);

    log.info(`[mock] approve(USDG → Exchange, ${cost.toFixed(4)})`);
    await sleep(300);
    log.info(`[mock] buyAndActivate(usdgIn=${usdgIn}, minCreditOut=${(q.creditOut * 0.99).toFixed(4)}, beneficiary=${forSelf ? "self" : beneficiary}, maxFills=${this.mockCfg.MAX_FILLS})`);
    await sleep(500);
    this.txCounter++;
    const txHash = `0xmock${this.txCounter.toString(16).padStart(60, "0")}`;
    if (forSelf) {
      const before = this.balance;
      this.balance += q.creditOut; // 1 CREDIT = $1 of activated balance
      log.info(`[mock] Activated ${q.creditOut.toFixed(4)} CREDIT. API balance $${before.toFixed(4)} → $${this.balance.toFixed(4)}`);
    } else {
      this.fundHook?.(beneficiary, q.creditOut);
      log.info(`[mock] Activated ${q.creditOut.toFixed(4)} CREDIT into ${beneficiary}`);
    }
    this.budgetGuard.record(cost);

    const record: RefuelRecord = {
      usdgSpent: cost,
      creditOut: q.creditOut,
      price: q.price,
      discount: q.discount,
      fills: q.fills,
      beneficiary: forSelf ? undefined : beneficiary,
      txHash,
      activationId: String(this.txCounter),
      dryRun: false,
      at: new Date().toISOString(),
    };
    this.refuels.push(record);
    return record;
  }

  override async activateHeld(): Promise<`0x${string}`> {
    throw new Error("[mock] activateHeld not simulated");
  }

  override async refuelGasCost(): Promise<number> {
    return 0.0005;
  }
}

export class MockLLM extends OrbioLLM {
  constructor(
    cfg: Config,
    private readonly credit: MockCreditManager,
  ) {
    super(cfg, "sk-orb-mock");
  }

  override async listModels(): Promise<string[]> {
    return ["anthropic/claude-fable-5.1", "openai/gpt-6-astra", "google/gemini-3-pro", "meta/llama-5-70b"];
  }

  override async complete(opts: { system: string; user: string; tier?: "cheap" | "search" | "strong"; json?: boolean }): Promise<string> {
    await sleep(400);
    const cost = opts.tier === "strong" ? MOCK_COST_PER_CALL * 2 : MOCK_COST_PER_CALL;
    if (this.credit.balance < cost) {
      // Mirrors the gateway rejecting a call once the activated balance is exhausted (HTTP 402).
      throw Object.assign(new Error("[mock] 402 Payment Required: insufficient balance"), { status: 402 });
    }
    this.usage.calls++;
    this.usage.promptTokens += 600 + Math.floor(Math.random() * 200);
    this.usage.completionTokens += 300 + Math.floor(Math.random() * 200);
    this.credit.charge(cost);
    log.debug(`[mock] ${opts.tier ?? "cheap"} call charged $${cost.toFixed(2)}, balance $${this.credit.balance.toFixed(4)}`);

    const topic = /研究主题：(.+)/.exec(opts.user)?.[1]?.trim() ?? "主题";

    if (/拆分为 (\d+) 个互补的子课题/.test(opts.system)) {
      const n = Number(/拆分为 (\d+) 个/.exec(opts.system)?.[1] ?? 3);
      const angles = ["背景、机制与关键参与方", "现状数据、代表案例与成本结构", "风险、争议与监管", "竞争格局与未来趋势", "技术实现与安全"];
      return JSON.stringify({
        subtopics: Array.from({ length: n }, (_, i) => ({
          worker: i + 1,
          topic: `${topic}：${angles[i % angles.length]}`,
          focus: angles[i % angles.length],
        })),
      });
    }
    if (/汇总多个工作 Agent 的研究报告/.test(opts.system)) {
      return `## 摘要\n协调者汇总了各工作 Agent 对「${topic}」的分工研究：机制、数据与风险三条线互相印证，结论为该市场处于早期但闭环已可运行。\n\n## 详细分析\n### 机制\n推理额度代币化后可持有、转让、激活。[来源: Orbio 文档]\n### 现状\n订单簿折扣约 18%，Agent 可自筹算力。[来源: 本次模拟运行日志]\n### 风险\n流动性不足时无法按策略续费。[来源: 本次模拟运行日志]\n\n## 分工与来源\n各工作 Agent 的子课题与来源见下方「团队分工」。\n\n## 结论\n1. 多 Agent 并行可缩短研究时间。\n2. 协调者集中购买、按需激活到工作 Agent，工作 Agent 无需 gas。\n3. 预算守卫应在协调者层统一执行。`;
    }

    if (/回答用户对一份已完成研究报告的追问/.test(opts.system)) {
      const q = /## 当前追问\n([\s\S]+)$/.exec(opts.user)?.[1]?.trim() ?? "";
      return `针对追问「${q}」：报告正文指出该领域处于早期阶段，折扣深度取决于卖方供给。[来源: 本次模拟运行日志]\n\n报告未涉及更细的量化数据，建议追加研究步骤：检索最近 30 天订单簿成交明细。`;
    }
    if (/对比两份研究报告/.test(opts.system)) {
      return `## 共同结论\n两份报告都认为链上推理额度市场处于早期。\n\n## 差异与矛盾\n报告 B 更强调流动性风险。\n\n## 数据变化\n| 指标 | A | B |\n|---|---|---|\n| 示例折扣 | 18% | 23.5% |\n\n## 可靠性评估\n两份报告来源相当。\n\n## 建议\n持续监控折扣变化。`;
    }

    if (opts.json) {
      return JSON.stringify({
        steps: [
          { step: 1, action: `梳理「${topic}」的背景与核心概念`, expected_output: "定义、发展脉络、关键参与方" },
          { step: 2, action: "收集现状数据与代表案例", expected_output: "3-5 个带来源的关键数据点" },
          { step: 3, action: "分析主要争议、风险与限制", expected_output: "风险清单及依据" },
          { step: 4, action: "对比可选方案与趋势判断", expected_output: "方案对比表与趋势结论" },
        ],
      });
    }

    if (/资深研究分析师/.test(opts.system)) {
      return `## 摘要
本报告围绕「${topic}」梳理了背景、现状、风险与趋势。核心判断：该领域正处于从概念验证走向规模化的早期阶段，链上可交易的推理额度使 Agent 能自筹算力，成本由市场折扣决定。

## 详细分析
### 背景
推理额度被代币化后成为可持有、转让、销毁的资源，Agent 无需人工开通账号即可获得访问权限。[来源: Orbio CREDIT 协议文档]

### 现状
订单簿与 Uniswap 池并存，套利使两个市场价格趋同；未使用的 CREDIT 以低于面值的价格流通。[来源: Orbio 文档 · 解锁]

### 风险
折扣深度取决于卖方供给；流动性不足时报价可能低于策略阈值，导致 Agent 无法续费。[来源: 本次模拟运行日志]

## 来源
- Orbio CREDIT 协议文档（2026 年 9 月）
- Robinhood Chain 合约：Exchange 0x6951…ebc0、CREDIT 0xe333…004c
- 本次模拟运行日志

## 结论
1. 自主续费在技术上可行，关键在折扣阈值与预算上限的设定。
2. 应同时接入订单簿和 Uniswap 路径以降低流动性风险。
3. 便宜模型做初筛、贵模型做总结可显著降低 CREDIT 消耗。`;
    }

    const stepNo = /当前步骤 (\d+)/.exec(opts.user)?.[1] ?? "?";
    return `- 要点 A：关于「${topic}」的第 ${stepNo} 步发现，示例数据 42%。[来源: 示例机构报告 2026]
- 要点 B：相关方包括协议方、质押者、Agent 运营者。[来源: Orbio 文档]
- 要点 C：不确定——缺乏公开的成交量统计。`;
  }
}
