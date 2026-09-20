import { BudgetGuard } from "./budget.js";
import { configWarnings, loadConfig, type Config } from "./config.js";
import { CreditManager } from "./credit-manager.js";
import { OrbioLLM } from "./llm.js";
import { createLogger, setLogLevel } from "./logger.js";
import { MockCreditManager, MockLLM } from "./mock.js";
import { ReportStore } from "./store.js";
import { WalletManager } from "./wallet.js";

const log = createLogger("runtime");

export interface Runtime {
  cfg: Config;
  wallet: WalletManager;
  credit: CreditManager;
  llm: OrbioLLM;
  store: ReportStore;
  budget: BudgetGuard;
  mock: boolean;
  mode: "MOCK" | "DRY RUN" | "LIVE";
}

export interface RuntimeOptions {
  mock?: boolean;
  live?: boolean;
  dryRun?: boolean;
}

/** Builds wallet, credit manager, LLM client and report store. Shared by the CLI and the web server. */
export async function createRuntime(opts: RuntimeOptions = {}): Promise<Runtime> {
  const mock = opts.mock ?? process.env.MOCK === "true";
  if (mock && !process.env.PRIVATE_KEY) {
    // Well-known throwaway key so the wallet can sign locally; never holds funds.
    process.env.PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
  }

  const cfg = loadConfig();
  setLogLevel(cfg.LOG_LEVEL);
  if (opts.live) cfg.DRY_RUN = false;
  if (opts.dryRun) cfg.DRY_RUN = true;
  for (const w of configWarnings(cfg)) log.warn(`config: ${w}`);

  const wallet = new WalletManager(cfg);
  const mode = mock ? "MOCK" : cfg.DRY_RUN ? "DRY RUN" : "LIVE";
  log.info(`Agent wallet ${wallet.address} on chain ${cfg.CHAIN_ID} (${mode})`);
  await wallet.ensureApiKey();

  const budget = new BudgetGuard(cfg.MAX_SPEND_PER_TASK, cfg.MAX_SPEND_PER_DAY, !mock);
  const credit = mock ? new MockCreditManager(cfg, wallet, budget) : new CreditManager(cfg, wallet, budget);
  const llm = mock ? new MockLLM(cfg, credit as MockCreditManager) : new OrbioLLM(cfg, wallet.getApiKey());
  const store = new ReportStore(cfg.REPORT_DIR);

  return { cfg, wallet, credit, llm, store, budget, mock, mode };
}
