/**
 * Uniswap v4 on Robinhood Chain — the fallback venue for buying CREDIT when the order book is
 * empty or worse than the pool route (docs: USDG → NVDA → ORBIO → CREDIT).
 *
 * Addresses found on chain 4663 (2026-09-22): PoolManager and a Universal Router deployment.
 * Permit2 is the canonical CREATE2 deployment. The v4 Quoter address must be configured
 * (UNISWAP_QUOTER) once a CREDIT pool exists; there is no official one to hard-code yet.
 */
export const UNISWAP = {
  POOL_MANAGER: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  UNIVERSAL_ROUTER: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
  PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  /** Universal Router command byte for a v4 swap. */
  COMMAND_V4_SWAP: 0x10,
  /** v4 router actions used by an exact-input multi-hop swap. */
  ACTION_SWAP_EXACT_IN: 0x07,
  ACTION_SETTLE_ALL: 0x0c,
  ACTION_TAKE_ALL: 0x0f,
  /** Hooks address meaning "no hook". */
  NO_HOOKS: "0x0000000000000000000000000000000000000000",
} as const;

/** One hop of a v4 path: the token you receive from this hop and the pool's identity. */
export const pathKeyComponents = [
  { type: "address", name: "intermediateCurrency" },
  { type: "uint24", name: "fee" },
  { type: "int24", name: "tickSpacing" },
  { type: "address", name: "hooks" },
  { type: "bytes", name: "hookData" },
] as const;

/** UniversalRouter.execute(bytes commands, bytes[] inputs, uint256 deadline) */
export const universalRouterAbi = [
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { type: "bytes", name: "commands" },
      { type: "bytes[]", name: "inputs" },
      { type: "uint256", name: "deadline" },
    ],
    outputs: [],
  },
] as const;

/** Permit2: the Universal Router pulls tokens through Permit2 allowances, not plain ERC-20 approvals. */
export const permit2Abi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "token" },
      { type: "address", name: "spender" },
      { type: "uint160", name: "amount" },
      { type: "uint48", name: "expiration" },
    ],
    outputs: [],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { type: "address", name: "user" },
      { type: "address", name: "token" },
      { type: "address", name: "spender" },
    ],
    outputs: [
      { type: "uint160", name: "amount" },
      { type: "uint48", name: "expiration" },
      { type: "uint48", name: "nonce" },
    ],
  },
] as const;

/**
 * v4 Quoter. quoteExactInput is not a view on chain (it reverts internally to read the result),
 * but it is meant to be called with eth_call, which is what declaring it `view` makes viem do.
 */
export const v4QuoterAbi = [
  {
    name: "quoteExactInput",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        type: "tuple",
        name: "params",
        components: [
          { type: "address", name: "exactCurrency" },
          { type: "tuple[]", name: "path", components: pathKeyComponents },
          { type: "uint128", name: "exactAmount" },
        ],
      },
    ],
    outputs: [
      { type: "uint256", name: "amountOut" },
      { type: "uint256", name: "gasEstimate" },
    ],
  },
] as const;
