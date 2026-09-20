import "dotenv/config";
import { z } from "zod";
import { ADDRESSES, ROBINHOOD_CHAIN_ID } from "./abi/orbio.js";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/, "must be 0x-prefixed hex");

const schema = z.object({
  PRIVATE_KEY: hex.length(66, "private key must be 32 bytes"),
  RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
  CHAIN_ID: z.coerce.number().int().positive().default(ROBINHOOD_CHAIN_ID),

  ORBIO_API_BASE: z.string().url().default("https://api.orbio.so/api/v1"),
  /** Epoch used to derive the API key from the wallet signature. Bump to rotate. */
  ORBIO_KEY_EPOCH: z.coerce.number().int().nonnegative().default(0),

  EXCHANGE_ADDRESS: hex.length(42).default(ADDRESSES.EXCHANGE),
  USDG_ADDRESS: hex.length(42).default(ADDRESSES.USDG),
  CREDIT_ADDRESS: hex.length(42).default(ADDRESSES.CREDIT),

  CHEAP_MODEL: z.string().default("openai/gpt-4o-mini"),
  /** Web-grounded model used to execute research steps (returns real citations). */
  SEARCH_MODEL: z.string().default("perplexity/sonar"),
  STRONG_MODEL: z.string().default("anthropic/claude-sonnet-4.5"),

  /** Refuel when API balance (USD) drops below this. */
  CREDIT_LOW_THRESHOLD: z.coerce.number().nonnegative().default(2),
  /** USDG to spend per refuel. */
  REFUEL_USDG: z.coerce.number().positive().default(5),
  /** Only buy when effective discount ≥ this (0.15 = 15%). Set 0 to accept any price ≤ $1. */
  MIN_DISCOUNT: z.coerce.number().min(0).max(0.99).default(0.15),
  /** Max order-book fills per buy (1 = single best order; docs suggest MAX_FILLS() for market buys). */
  MAX_FILLS: z.coerce.number().int().positive().default(5),

  MAX_SPEND_PER_TASK: z.coerce.number().positive().default(5),
  MAX_SPEND_PER_DAY: z.coerce.number().positive().default(20),
  /** USD of gateway (API) spend allowed per research run; beyond it the run stops and saves a partial report. */
  MAX_API_SPEND_PER_TASK: z.coerce.number().positive().default(1),

  // ===== Team mode (coordinator + worker agents) =====
  /** Default number of worker agents for `team` runs. */
  WORKER_COUNT: z.coerce.number().int().min(1).max(8).default(3),
  /** Research steps each worker performs on its sub-topic. */
  WORKER_STEPS: z.coerce.number().int().min(1).max(6).default(2),
  /** A worker asks the coordinator for funding when its API balance (USD) drops below this. */
  WORKER_LOW_THRESHOLD: z.coerce.number().nonnegative().default(0.05),
  /** USDG the coordinator spends per worker top-up (buyAndActivate with beneficiary = worker). */
  WORKER_FUND_USDG: z.coerce.number().positive().default(0.1),

  DRY_RUN: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  REPORT_DIR: z.string().default("./reports"),
});

export type Config = z.infer<typeof schema> & { PRIVATE_KEY: `0x${string}` };

export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration (.env):\n${issues}`);
  }
  return parsed.data as Config;
}

/** Settings that parse fine but cannot work together; logged as warnings at startup. */
export function configWarnings(cfg: Config): string[] {
  const w: string[] = [];
  if (cfg.REFUEL_USDG > cfg.MAX_SPEND_PER_TASK) {
    w.push(`REFUEL_USDG (${cfg.REFUEL_USDG}) > MAX_SPEND_PER_TASK (${cfg.MAX_SPEND_PER_TASK}): every refuel will be refused by the budget guard`);
  }
  if (cfg.REFUEL_USDG > cfg.MAX_SPEND_PER_DAY) {
    w.push(`REFUEL_USDG (${cfg.REFUEL_USDG}) > MAX_SPEND_PER_DAY (${cfg.MAX_SPEND_PER_DAY}): every refuel will be refused by the budget guard`);
  }
  if (cfg.MAX_SPEND_PER_TASK > cfg.MAX_SPEND_PER_DAY) {
    w.push(`MAX_SPEND_PER_TASK (${cfg.MAX_SPEND_PER_TASK}) > MAX_SPEND_PER_DAY (${cfg.MAX_SPEND_PER_DAY}): the daily cap is the effective per-task limit`);
  }
  if (cfg.WORKER_FUND_USDG > cfg.MAX_SPEND_PER_TASK) {
    w.push(`WORKER_FUND_USDG (${cfg.WORKER_FUND_USDG}) > MAX_SPEND_PER_TASK (${cfg.MAX_SPEND_PER_TASK}): worker agents can never be funded`);
  } else if (cfg.WORKER_FUND_USDG * cfg.WORKER_COUNT > cfg.MAX_SPEND_PER_TASK) {
    const affordable = Math.floor(cfg.MAX_SPEND_PER_TASK / cfg.WORKER_FUND_USDG);
    w.push(
      `WORKER_FUND_USDG × WORKER_COUNT (${(cfg.WORKER_FUND_USDG * cfg.WORKER_COUNT).toFixed(2)}) > MAX_SPEND_PER_TASK (${cfg.MAX_SPEND_PER_TASK}): only ${affordable} worker funding(s) per team run will be approved`,
    );
  }
  return w;
}

export const CONSTANTS = {
  MAX_RETRIES: 3,
  RETRY_BASE_MS: 1500,
  BALANCE_CHECK_EVERY_N_STEPS: 2,
  ACTIVATION_POLL_MS: 4000,
  ACTIVATION_POLL_MAX: 15,
  MAX_PLAN_STEPS: 8,
} as const;
