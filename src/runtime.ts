import { BudgetGuard } from "./budget.js";
import { configWarnings, loadConfig, type Config } from "./config.js";
import { CreditManager } from "./credit-manager.js";
import { OrbioLLM } from "./llm.js";
import { createLogger, setLogLevel } from "./logger.js";
import { MarketMaker } from "./market.js";
import { MockCreditManager, MockLLM, MockSwapRoute } from "./mock.js";
import { ReportStore } from "./store.js";
import { UniswapRoute } from "./uniswap.js";
import { WalletManager } from "./wallet.js";

const log = createLogger("runtime");

export interface Runtime {
  cfg: Config;
  wallet: WalletManager;
  credit: CreditManager;
  llm: OrbioLLM;
  store: ReportStore;
  budget: BudgetGuard;
  market: MarketMaker;
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
  if (mock && !/^0x[0-9a-fA-F]{64}$/.test(process.env.PRIVATE_KEY ?? "")) {
    // Mock mode never touches the chain: use a well-known throwaway key so the wallet can sign
    // locally, even when .env still holds the `0x...` placeholder from .env.example.
    process.env.PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
  }

  const cfg = loadConfig();
  setLogLevel(cfg.LOG_LEVEL);
  if (opts.live) cfg.DRY_RUN = false;
  if (opts.dryRun) cfg.DRY_RUN = true;
  // The Uniswap-quoter warning is about real-mode wiring; the mock route needs no quoter.
  for (const w of configWarnings(cfg)) if (!(mock && w.includes("UNISWAP_QUOTER"))) log.warn(`config: ${w}`);

  const wallet = new WalletManager(cfg);
  const mode = mock ? "MOCK" : cfg.DRY_RUN ? "DRY RUN" : "LIVE";
  log.info(`Agent wallet ${wallet.address} on chain ${cfg.CHAIN_ID} (${mode})`);
  await wallet.ensureApiKey();

  const budget = new BudgetGuard(cfg.MAX_SPEND_PER_TASK, cfg.MAX_SPEND_PER_DAY, !mock);
  const credit = mock ? new MockCreditManager(cfg, wallet, budget) : new CreditManager(cfg, wallet, budget);
  // Second venue for buying CREDIT. Real mode needs UNISWAP_PATH + UNISWAP_QUOTER; mock mode
  // enables an offline stand-in whenever UNISWAP_PATH is set to anything.
  credit.setRoute(mock ? (cfg.UNISWAP_PATH ? new MockSwapRoute() : undefined) : UniswapRoute.fromConfig(cfg, wallet));
  const llm = mock ? new MockLLM(cfg, credit as MockCreditManager) : new OrbioLLM(cfg, wallet.getApiKey());
  const store = new ReportStore(cfg.REPORT_DIR);
  const market = new MarketMaker(cfg, credit, !mock);

  return { cfg, wallet, credit, llm, store, budget, market, mock, mode };
}
