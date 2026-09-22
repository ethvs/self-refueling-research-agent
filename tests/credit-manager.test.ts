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
  const mm = { ...baseCfg, MARKET_MAKER: true, INVENTORY_USDG: 0.3, INVENTORY_DISCOUNT: 0.25, SELL_MIN_PRICE: 0.8 } as Config;
  assert.deepEqual(configWarnings(mm), []);
  assert.match(configWarnings({ ...mm, SELL_MIN_PRICE: 0.7 })[0]!, /listed below what it cost/);
  assert.match(configWarnings({ ...mm, INVENTORY_USDG: 5 })[0]!, /restocking will always be refused/);
});

// ---- order-book sell side ----

test("choosePrice joins the best ask, respects the floor, rounds up to the tick and caps at par", () => {
  assert.equal(CreditManager.choosePrice(7250, 0.8), 8000); // best ask below floor → floor
  assert.equal(CreditManager.choosePrice(8500, 0.8), 8500); // best ask above floor → join it
  assert.equal(CreditManager.choosePrice(0, 0.8), 8000); // empty book → floor
  assert.equal(CreditManager.choosePrice(7250, 0.81), 8250); // floor not on the tick → next tick up
  assert.equal(CreditManager.choosePrice(9900, 0.8), 10000); // never above 1.0000
  assert.equal(CreditManager.choosePrice(7250, 0.5, 10000, 250), 7250);
});

test("MarketMaker lists only the surplus above the reserve, and only from the Exchange minimum up", async () => {
  const { MarketMaker } = await import("../src/market.js");
  const sold: Array<[number, number]> = [];
  const book = { bestPrice: 0.725, bestPriceRaw: 7250, priceScale: 10000, priceTick: 250, minOrder: 5, feeBps: 200, depthCredit: 100, depthUsdg: 80, openOrders: 3 };
  const fake = (held: number) =>
    ({
      book: async () => book,
      walletBalances: async () => ({ usdg: 1, credit: held, eth: 0.01 }),
      sell: async (credit: number, priceRaw: number) => {
        sold.push([credit, priceRaw]);
        return { orderId: "1", credit, price: priceRaw / 10000, priceRaw, dryRun: false, at: "" };
      },
      orderOf: async () => ({ orderId: "1", seller: "0x", price: 0.8, priceRaw: 8000, remaining: 1, filled: 0, status: "open" as const }),
    }) as unknown as CreditManager;
  const cfg = { CREDIT_RESERVE: 2, SELL_MIN_PRICE: 0.8, INVENTORY_USDG: 0 } as Config;
  assert.equal(await new MarketMaker(cfg, fake(6), false).listSurplus(), undefined); // 6 − 2 = 4 < min order 5
  const rec = await new MarketMaker(cfg, fake(9), false).listSurplus(); // 9 − 2 = 7 ≥ 5
  assert.equal(rec?.credit, 7);
  assert.deepEqual(sold, [[7, 8000]]);
});

test("MarketMaker restocks only when the previous batch is gone and the book is cheap enough", async () => {
  const { MarketMaker } = await import("../src/market.js");
  let bought = 0;
  const book = { bestPrice: 0.725, bestPriceRaw: 7250, priceScale: 10000, priceTick: 250, minOrder: 5, feeBps: 200, depthCredit: 100, depthUsdg: 80, openOrders: 3 };
  const fake = (held: number, discount: number) =>
    ({
      walletBalances: async () => ({ usdg: 10, credit: held, eth: 0.01 }),
      quote: async () => ({ creditOut: 1.3, discount }),
      buyHeld: async () => {
        bought++;
        return { usdgSpent: 1, creditOut: 1.3, price: 0.77, discount, fills: 1, dryRun: false, at: "" };
      },
    }) as unknown as CreditManager;
  const cfg = { CREDIT_RESERVE: 0, SELL_MIN_PRICE: 0.8, INVENTORY_USDG: 1, INVENTORY_DISCOUNT: 0.25 } as Config;
  const open = [{ orderId: "1", seller: "0x" as `0x${string}`, price: 0.8, priceRaw: 8000, remaining: 5, filled: 0, status: "open" as const }];
  assert.equal(await new MarketMaker(cfg, fake(0, 0.3), false).restock(book, open), undefined); // an ask is still open
  assert.equal(await new MarketMaker(cfg, fake(6, 0.3), false).restock(book, []), undefined); // unlisted surplus still held
  assert.equal(await new MarketMaker(cfg, fake(0, 0.2), false).restock(book, []), undefined); // book not cheap enough
  assert.equal(bought, 0);
  assert.ok(await new MarketMaker(cfg, fake(0, 0.3), false).restock(book, []));
  assert.equal(bought, 1);
});

// ---- Uniswap fallback route ----

test("pickSource takes the venue that returns more CREDIT, and falls back when one fails policy", () => {
  const book = { creditOut: 1.22, discount: 0.18 };
  assert.equal(CreditManager.pickSource(book, undefined, 0.15), "book"); // no route configured
  assert.equal(CreditManager.pickSource(book, { creditOut: 1.27, discount: 0.21 }, 0.15), "uniswap"); // more CREDIT
  assert.equal(CreditManager.pickSource(book, { creditOut: 1.2, discount: 0.17 }, 0.15), "book"); // less CREDIT
  assert.equal(CreditManager.pickSource(book, { creditOut: 1.27, discount: 0.21 }, 0.2), "uniswap"); // book fails policy
  assert.equal(CreditManager.pickSource({ creditOut: 0, discount: 1 }, { creditOut: 1.27, discount: 0.21 }, 0.15), "uniswap"); // empty book
  assert.equal(CreditManager.pickSource(book, { creditOut: 1.1, discount: 0.09 }, 0.2), undefined); // both fail
  assert.equal(CreditManager.pickSource(book, { creditOut: 0, discount: 1 }, 0.15), "book"); // route quoted nothing
});

test("parsePath resolves symbols, validates pool keys and requires the path to end at CREDIT", async () => {
  const { parsePath } = await import("../src/uniswap.js");
  const { ADDRESSES } = await import("../src/abi/orbio.js");
  const hops = parsePath('[{"token":"NVDA","fee":3000,"tickSpacing":60},{"token":"orbio","fee":3000,"tickSpacing":60},{"token":"CREDIT","fee":500,"tickSpacing":10}]');
  assert.equal(hops.length, 3);
  assert.equal(hops[0]!.token, ADDRESSES.NVDA);
  assert.equal(hops[1]!.token, ADDRESSES.ORBIO);
  assert.equal(hops[2]!.token, ADDRESSES.CREDIT);
  assert.equal(hops[2]!.hooks, "0x0000000000000000000000000000000000000000");
  assert.throws(() => parsePath("not json"), /JSON array/);
  assert.throws(() => parsePath('[{"token":"NVDA","fee":3000,"tickSpacing":60}]'), /must end at CREDIT/);
  assert.throws(() => parsePath('[{"token":"CREDIT","fee":-1,"tickSpacing":60}]'), /fee/);
  assert.throws(() => parsePath('[{"token":"WHAT","fee":500,"tickSpacing":10}]'), /unknown token/);
});

test("encodeV4SwapInput produces the Universal Router V4_SWAP input (actions + params) that decodes back", async () => {
  const { encodeV4SwapInput, parsePath } = await import("../src/uniswap.js");
  const { ADDRESSES } = await import("../src/abi/orbio.js");
  const { pathKeyComponents } = await import("../src/abi/uniswap.js");
  const { decodeAbiParameters } = await import("viem");
  const hops = parsePath('[{"token":"NVDA","fee":3000,"tickSpacing":60},{"token":"CREDIT","fee":500,"tickSpacing":10}]');
  const input = encodeV4SwapInput(ADDRESSES.USDG, hops, 5_000_000n, 6_000_000n);
  const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], input);
  assert.equal(actions, "0x070c0f"); // SWAP_EXACT_IN, SETTLE_ALL, TAKE_ALL
  assert.equal(params.length, 3);
  const [swap] = decodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { type: "address", name: "currencyIn" },
          { type: "tuple[]", name: "path", components: pathKeyComponents },
          { type: "uint128", name: "amountIn" },
          { type: "uint128", name: "amountOutMinimum" },
        ],
      },
    ],
    params[0]!,
  );
  const lower = (a: string) => a.toLowerCase();
  assert.equal(lower(swap.currencyIn), lower(ADDRESSES.USDG));
  assert.equal(swap.path.length, 2);
  assert.equal(lower(swap.path[1]!.intermediateCurrency), lower(ADDRESSES.CREDIT));
  assert.equal(swap.path[0]!.fee, 3000);
  assert.equal(swap.amountIn, 5_000_000n);
  assert.equal(swap.amountOutMinimum, 6_000_000n);
  const [settleToken, settleMax] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[1]!);
  const [takeToken, takeMin] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[2]!);
  assert.equal(lower(settleToken), lower(ADDRESSES.USDG));
  assert.equal(settleMax, 5_000_000n);
  assert.equal(lower(takeToken), lower(ADDRESSES.CREDIT));
  assert.equal(takeMin, 6_000_000n);
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
