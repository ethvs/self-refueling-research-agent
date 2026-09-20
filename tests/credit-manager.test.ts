import { test } from "node:test";
import assert from "node:assert/strict";
import { CreditManager } from "../src/credit-manager.js";
import { BudgetGuard } from "../src/budget.js";
import { privateKeyToAccount } from "viem/accounts";
import { deriveWorkerKey } from "../src/team.js";
import { configWarnings, type Config } from "../src/config.js";
import { isInsufficientBalance, type OrbioLLM } from "../src/llm.js";
import { renderReport } from "../src/report.js";
import { ResearchAgent, ResearchInterrupted } from "../src/research-agent.js";

test("deriveWorkerKey is deterministic, distinct per index, and does not equal the master key", () => {
  const master = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
  const a1 = deriveWorkerKey(master, 1);
  const a2 = deriveWorkerKey(master, 2);
  assert.equal(a1, deriveWorkerKey(master, 1));
  assert.notEqual(a1, a2);
  assert.notEqual(a1, master);
  assert.match(a1, /^0x[0-9a-f]{64}$/);
  assert.notEqual(privateKeyToAccount(a1).address, privateKeyToAccount(a2).address);
});

test("acceptable(): enforces discount floor and non-empty fill", () => {
  assert.equal(CreditManager.acceptable({ creditOut: 100, discount: 0.2 }, 0.15), true);
  assert.equal(CreditManager.acceptable({ creditOut: 100, discount: 0.1 }, 0.15), false);
  assert.equal(CreditManager.acceptable({ creditOut: 0, discount: 1 }, 0.15), false);
  assert.equal(CreditManager.acceptable({ creditOut: 5, discount: 0 }, 0), true);
});

test("BudgetGuard rejects spend over per-task cap", () => {
  const b = new BudgetGuard(1, 100, false);
  b.assertCanSpend(0.9);
  assert.throws(() => b.assertCanSpend(1.1), /Task budget exceeded/);
});

test("API key derivation matches the documented format", async () => {
  const account = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001");
  const epoch = 0;
  const signature = await account.signMessage({ message: `Orbio API key · chain 4663 · epoch ${epoch}` });
  const key = `sk-orb-${epoch}-${Buffer.from(signature.slice(2), "hex").toString("base64")}`;
  assert.match(key, /^sk-orb-0-[A-Za-z0-9+/]+=*$/);
  assert.equal(Buffer.from(key.split("-")[3]!, "base64").length, 65); // r,s,v
});

const baseCfg = {
  REFUEL_USDG: 0.3,
  MAX_SPEND_PER_TASK: 0.5,
  MAX_SPEND_PER_DAY: 1,
  WORKER_FUND_USDG: 0.1,
  WORKER_COUNT: 3,
} as Config;

test("configWarnings flags budgets that can never be satisfied", () => {
  assert.deepEqual(configWarnings(baseCfg), []);
  assert.match(configWarnings({ ...baseCfg, REFUEL_USDG: 0.6 })[0]!, /REFUEL_USDG .* > MAX_SPEND_PER_TASK/);
  assert.match(configWarnings({ ...baseCfg, WORKER_COUNT: 8 })[0]!, /only 5 worker funding/);
  assert.match(configWarnings({ ...baseCfg, WORKER_FUND_USDG: 0.9 })[0]!, /can never be funded/);
});

test("isInsufficientBalance recognises HTTP 402 and balance messages, not other errors", () => {
  assert.equal(isInsufficientBalance(Object.assign(new Error("Payment Required"), { status: 402 })), true);
  assert.equal(isInsufficientBalance(new Error("insufficient balance for this request")), true);
  assert.equal(isInsufficientBalance(Object.assign(new Error("No provider is currently serving this model"), { status: 404 })), false);
  assert.equal(isInsufficientBalance(new Error("ECONNRESET")), false);
});

test("renderReport marks a partial run and keeps the finished steps", () => {
  const credit = { refuels: [], totalSpent: () => 0 } as unknown as CreditManager;
  const outcome = {
    topic: "t",
    plan: { steps: [{ step: 1, action: "a", expected_output: "x" }, { step: 2, action: "b", expected_output: "y" }] },
    results: [{ step: 1, action: "a", expected_output: "x", output: "finding one", refueledBefore: false }],
    synthesis: "",
    startedAt: "2026-09-20T00:00:00.000Z",
    finishedAt: "2026-09-20T00:01:00.000Z",
    status: "partial" as const,
    error: "API spend cap exceeded",
  };
  const { markdown } = renderReport(outcome, credit, {
    creditBefore: 1,
    creditAfter: 0.9,
    usage: { calls: 2, promptTokens: 10, completionTokens: 5 },
    model: { cheap: "c", search: "s", strong: "st" },
    address: "0xabc",
  });
  assert.match(markdown, /本次研究未完成.*API spend cap exceeded.*已完成 1\/2 步/);
  assert.match(markdown, /finding one/);
  assert.match(markdown, /（未生成总结）/);
});

// ---- ResearchAgent behaviour with fake LLM / credit ----

const plan = (n: number) => JSON.stringify({ steps: Array.from({ length: n }, (_, i) => ({ step: i + 1, action: `查资料 ${i + 1}`, expected_output: "带来源的要点" })) });

function fakeLLM(onCall: (opts: { json?: boolean; tier?: string }, n: number) => string | Promise<string>): OrbioLLM {
  let n = 0;
  return { usage: { calls: 0, promptTokens: 0, completionTokens: 0 }, complete: (opts: { json?: boolean; tier?: string }) => onCall(opts, ++n) } as unknown as OrbioLLM;
}

function fakeCredit(refuelNow: () => Promise<unknown> = async () => ({}), ensureFuel: () => Promise<boolean> = async () => false) {
  return { getBalance: async () => 1, ensureFuel, refuelNow } as unknown as CreditManager;
}

test("ResearchAgent keeps working when a checkpoint refuel is refused by policy or budget", async () => {
  const llm = fakeLLM((opts) => (opts.json ? plan(3) : "step output"));
  const credit = fakeCredit(undefined, async () => {
    throw new Error("Task budget exceeded");
  });
  const outcome = await new ResearchAgent(llm, credit, { maxSteps: 3, synthesisTier: "cheap" }).run("t");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.results.length, 3);
});

test("ResearchAgent retries the planner once when the first plan is not JSON", async () => {
  let planCalls = 0;
  const llm = fakeLLM((opts) => {
    if (opts.json) return ++planCalls === 1 ? "抱歉，计划如下：第一步……" : plan(1);
    return "step output";
  });
  const outcome = await new ResearchAgent(llm, fakeCredit(), { maxSteps: 1, synthesisTier: "cheap" }).run("t");
  assert.equal(planCalls, 2);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.results.length, 1);
});

test("ResearchAgent refuels immediately when the gateway reports an exhausted balance, then retries once", async () => {
  let refuels = 0;
  let failed = false;
  const llm = fakeLLM((opts) => {
    if (opts.json) return plan(1);
    if (!failed) {
      failed = true;
      throw Object.assign(new Error("insufficient balance"), { status: 402 });
    }
    return "step output";
  });
  const credit = fakeCredit(async () => {
    refuels++;
    return {};
  });
  const outcome = await new ResearchAgent(llm, credit, { maxSteps: 1, synthesisTier: "cheap" }).run("t");
  assert.equal(refuels, 1);
  assert.equal(outcome.status, "completed");
});

test("ResearchAgent surfaces the finished steps when a later step fails", async () => {
  const llm = fakeLLM((opts, n) => {
    if (opts.json) return plan(2);
    if (n === 2) return "finding one";
    throw new Error("ECONNRESET");
  });
  await assert.rejects(
    () => new ResearchAgent(llm, fakeCredit(), { maxSteps: 2, synthesisTier: "cheap" }).run("t"),
    (e: unknown) => e instanceof ResearchInterrupted && e.partial.status === "partial" && e.partial.results.length === 1 && /ECONNRESET/.test(e.message),
  );
});
