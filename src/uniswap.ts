import { encodeAbiParameters, encodePacked, formatUnits, parseUnits, type Address, type Hex } from "viem";
import { ADDRESSES, erc20Abi, TOKEN_DECIMALS } from "./abi/orbio.js";
import { pathKeyComponents, permit2Abi, UNISWAP, universalRouterAbi, v4QuoterAbi } from "./abi/uniswap.js";
import type { Config } from "./config.js";
import type { RouteQuote, SwapRoute } from "./credit-manager.js";
import { createLogger } from "./logger.js";
import type { WalletManager } from "./wallet.js";

const log = createLogger("uniswap");

const toUnits = (n: number) => parseUnits(n.toFixed(TOKEN_DECIMALS), TOKEN_DECIMALS);
const fromUnits = (n: bigint) => Number(formatUnits(n, TOKEN_DECIMALS));

/** One hop as configured in UNISWAP_PATH; `token` is the token received from the hop. */
export interface PathHop {
  token: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

const TOKEN_NAMES: Record<string, Address> = {
  USDG: ADDRESSES.USDG,
  NVDA: ADDRESSES.NVDA,
  ORBIO: ADDRESSES.ORBIO,
  CREDIT: ADDRESSES.CREDIT,
};

/**
 * Parse UNISWAP_PATH: a JSON array of hops, e.g.
 *   [{"token":"NVDA","fee":3000,"tickSpacing":60},{"token":"ORBIO","fee":3000,"tickSpacing":60},{"token":"CREDIT","fee":500,"tickSpacing":10}]
 * Token may be a symbol (USDG/NVDA/ORBIO/CREDIT) or an address; `hooks` defaults to none.
 * The path starts at USDG and must end at CREDIT.
 */
export function parsePath(raw: string, creditAddress: Address = ADDRESSES.CREDIT): PathHop[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("UNISWAP_PATH must be a JSON array of hops: [{\"token\":\"NVDA\",\"fee\":3000,\"tickSpacing\":60}, …]");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("UNISWAP_PATH must contain at least one hop");
  const hops = parsed.map((h, i) => {
    const hop = h as { token?: string; fee?: number; tickSpacing?: number; hooks?: string };
    const token = hop.token ? (TOKEN_NAMES[hop.token.toUpperCase()] ?? hop.token) : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error(`UNISWAP_PATH hop ${i + 1}: unknown token "${hop.token}"`);
    if (!Number.isInteger(hop.fee) || hop.fee! < 0 || hop.fee! > 1_000_000) throw new Error(`UNISWAP_PATH hop ${i + 1}: fee must be an integer in [0, 1000000] (e.g. 3000 = 0.3%)`);
    if (!Number.isInteger(hop.tickSpacing) || hop.tickSpacing! <= 0) throw new Error(`UNISWAP_PATH hop ${i + 1}: tickSpacing must be a positive integer`);
    const hooks = hop.hooks ?? UNISWAP.NO_HOOKS;
    if (!/^0x[0-9a-fA-F]{40}$/.test(hooks)) throw new Error(`UNISWAP_PATH hop ${i + 1}: hooks must be an address`);
    return { token: token as Address, fee: hop.fee!, tickSpacing: hop.tickSpacing!, hooks: hooks as Address };
  });
  if (hops[hops.length - 1]!.token.toLowerCase() !== creditAddress.toLowerCase()) throw new Error("UNISWAP_PATH must end at CREDIT");
  return hops;
}

function pathKeys(hops: PathHop[]) {
  return hops.map((h) => ({ intermediateCurrency: h.token, fee: h.fee, tickSpacing: h.tickSpacing, hooks: h.hooks, hookData: "0x" as Hex }));
}

/**
 * Encode the single Universal Router input for an exact-input v4 swap along `hops`:
 *   actions = SWAP_EXACT_IN ‖ SETTLE_ALL ‖ TAKE_ALL
 *   params  = [ExactInputParams, (currencyIn, amountIn), (currencyOut, minOut)]
 * Pure, unit-tested by decoding it back.
 */
export function encodeV4SwapInput(currencyIn: Address, hops: PathHop[], amountIn: bigint, minOut: bigint): Hex {
  const actions = encodePacked(["uint8", "uint8", "uint8"], [UNISWAP.ACTION_SWAP_EXACT_IN, UNISWAP.ACTION_SETTLE_ALL, UNISWAP.ACTION_TAKE_ALL]);
  const currencyOut = hops[hops.length - 1]!.token;
  const params: Hex[] = [
    encodeAbiParameters(
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
      [{ currencyIn, path: pathKeys(hops), amountIn, amountOutMinimum: minOut }],
    ),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyIn, amountIn]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyOut, minOut]),
  ];
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params]);
}

/**
 * UniswapRoute — buy CREDIT with USDG through Uniswap v4 pools via the Universal Router.
 * Used by CreditManager.purchase() as an alternative to the Exchange order book: both venues are
 * quoted, the one that returns more CREDIT for the same USDG wins, and either alone is used when the
 * other is empty or fails the discount policy. CREDIT bought here lands in the wallet unactivated;
 * the purchase then activates it (credit.activate), so the agent's API balance ends up the same.
 */
export class UniswapRoute implements SwapRoute {
  readonly name = "uniswap";

  constructor(
    private readonly cfg: Config,
    private readonly wallet: WalletManager,
    readonly hops: PathHop[],
    private readonly quoter: Address,
    private readonly router: Address,
    private readonly permit2: Address,
  ) {}

  /** Build from .env; undefined when the route is not configured (no path or no quoter). */
  static fromConfig(cfg: Config, wallet: WalletManager): UniswapRoute | undefined {
    if (!cfg.UNISWAP_PATH) return undefined;
    if (!cfg.UNISWAP_QUOTER) {
      log.warn("UNISWAP_PATH is set but UNISWAP_QUOTER is empty: the Uniswap route stays disabled");
      return undefined;
    }
    const hops = parsePath(cfg.UNISWAP_PATH, cfg.CREDIT_ADDRESS as Address);
    const route = new UniswapRoute(cfg, wallet, hops, cfg.UNISWAP_QUOTER as Address, cfg.UNISWAP_ROUTER as Address, cfg.PERMIT2_ADDRESS as Address);
    log.info(`Uniswap route enabled: ${route.describe()}`);
    return route;
  }

  describe(): string {
    const name = (a: Address) => Object.entries(TOKEN_NAMES).find(([, addr]) => addr.toLowerCase() === a.toLowerCase())?.[0] ?? `${a.slice(0, 6)}…${a.slice(-4)}`;
    return ["USDG", ...this.hops.map((h) => `${name(h.token)} (fee ${h.fee}${h.hooks !== UNISWAP.NO_HOOKS ? ", hooked" : ""})`)].join(" → ");
  }

  /** Quote through the v4 Quoter: how much CREDIT `usdgIn` buys along the path right now. */
  async quote(usdgIn: number): Promise<RouteQuote> {
    const [amountOut, gasEstimate] = await this.wallet.publicClient.readContract({
      address: this.quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInput",
      args: [{ exactCurrency: this.cfg.USDG_ADDRESS as Address, path: pathKeys(this.hops), exactAmount: toUnits(usdgIn) }],
    });
    const creditOut = fromUnits(amountOut);
    const price = creditOut > 0 ? usdgIn / creditOut : Infinity;
    return { source: "uniswap", usdgIn, creditOut, price, discount: 1 - price, gasEstimate: Number(gasEstimate) };
  }

  /**
   * Swap `usdgIn` USDG for at least `minCreditOut` CREDIT into this wallet:
   *   USDG.approve(Permit2) → Permit2.approve(USDG, router) → UniversalRouter.execute(V4_SWAP)
   * Returns the CREDIT actually received (balance delta).
   */
  async swap(usdgIn: number, minCreditOut: number): Promise<{ hash: Hex; creditOut: number }> {
    const { walletClient, publicClient, account, chain, address } = this.wallet;
    const usdg = this.cfg.USDG_ADDRESS as Address;
    const credit = this.cfg.CREDIT_ADDRESS as Address;
    const amountIn = toUnits(usdgIn);
    const minOut = toUnits(minCreditOut);

    // 1. ERC-20 allowance for Permit2 (exact amount, like the Exchange approvals).
    const erc20Allowance = await publicClient.readContract({ address: usdg, abi: erc20Abi, functionName: "allowance", args: [address, this.permit2] });
    if (erc20Allowance < amountIn) {
      log.info(`Approving ${usdgIn} USDG for Permit2`);
      const h = await walletClient.writeContract({ address: usdg, abi: erc20Abi, functionName: "approve", args: [this.permit2, amountIn], account, chain });
      const r = await publicClient.waitForTransactionReceipt({ hash: h });
      if (r.status !== "success") throw new Error(`approve (Permit2) reverted: ${h}`);
    }

    // 2. Permit2 allowance for the router, valid for 30 minutes.
    const [p2Amount, p2Expiry] = await publicClient.readContract({ address: this.permit2, abi: permit2Abi, functionName: "allowance", args: [address, usdg, this.router] });
    const now = Math.floor(Date.now() / 1000);
    if (p2Amount < amountIn || p2Expiry <= now) {
      log.info(`Permit2.approve(USDG → Universal Router, ${usdgIn})`);
      const h = await walletClient.writeContract({
        address: this.permit2,
        abi: permit2Abi,
        functionName: "approve",
        args: [usdg, this.router, amountIn, now + 30 * 60],
        account,
        chain,
      });
      const r = await publicClient.waitForTransactionReceipt({ hash: h });
      if (r.status !== "success") throw new Error(`Permit2.approve reverted: ${h}`);
    }

    // 3. The swap itself.
    const before = await publicClient.readContract({ address: credit, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    const commands = encodePacked(["uint8"], [UNISWAP.COMMAND_V4_SWAP]);
    const input = encodeV4SwapInput(usdg, this.hops, amountIn, minOut);
    log.info(`UniversalRouter.execute(V4_SWAP: ${usdgIn} USDG → ≥ ${minCreditOut.toFixed(4)} CREDIT via ${this.describe()})`);
    const hash = await walletClient.writeContract({
      address: this.router,
      abi: universalRouterAbi,
      functionName: "execute",
      args: [commands, [input], BigInt(now + 10 * 60)],
      account,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Uniswap swap reverted: ${hash}`);
    const after = await publicClient.readContract({ address: credit, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    const creditOut = fromUnits(after - before);
    log.info(`swap confirmed in block ${receipt.blockNumber}: ${hash} → +${creditOut.toFixed(4)} CREDIT in the wallet`);
    return { hash, creditOut };
  }
}
