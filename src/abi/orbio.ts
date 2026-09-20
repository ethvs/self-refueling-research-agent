/**
 * Orbio contracts on Robinhood Chain (chain id 4663).
 * ABIs are the integration subsets published in the Orbio docs.
 * USDG and CREDIT both use 6 decimals (1 token = 1_000_000 units).
 */

export const ROBINHOOD_CHAIN_ID = 4663;

export const ADDRESSES = {
  CREDIT: "0xe33322da1380e61e5ae5dfb21e7f62924c73004c",
  STAKING: "0xe0710011278bfb63e57c5f227e5980984b1eddca",
  EXCHANGE: "0x6951ffd32630b05e06f50062aea801625a58ebc0",
  PAYOUT: "0x4cbbbf652b11ed1294df0ac49d8322394310cfc5",
  ORBIO: "0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3",
  USDG: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
} as const;

export const TOKEN_DECIMALS = 6;

/** Exchange (order book): getQuote / buy / buyAndActivate / getQuoteForCredit */
export const exchangeAbi = [
  {
    name: "getQuote",
    type: "function",
    stateMutability: "view",
    inputs: [
      { type: "uint256", name: "usdgIn" },
      { type: "uint256", name: "maxFills" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { type: "uint256", name: "creditOut" },
          { type: "uint256", name: "usdgSpent" },
          { type: "uint256", name: "feeAtoms" },
          { type: "uint256", name: "fills" },
          { type: "uint8", name: "reason" },
        ],
      },
    ],
  },
  {
    name: "getQuoteForCredit",
    type: "function",
    stateMutability: "view",
    inputs: [
      { type: "uint256", name: "creditOut" },
      { type: "uint256", name: "maxFills" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { type: "uint256", name: "usdgSpent" },
          { type: "uint256", name: "feeAtoms" },
          { type: "uint256", name: "fills" },
          { type: "uint8", name: "reason" },
        ],
      },
    ],
  },
  {
    name: "buy",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "usdgIn" },
      { type: "uint256", name: "minCreditOut" },
      { type: "address", name: "recipient" },
      { type: "uint256", name: "maxFills" },
    ],
    outputs: [
      { type: "uint256", name: "creditOut" },
      { type: "uint256", name: "usdgSpent" },
    ],
  },
  {
    name: "buyAndActivate",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "usdgIn" },
      { type: "uint256", name: "minCreditOut" },
      { type: "bytes32", name: "beneficiary" },
      { type: "uint256", name: "maxFills" },
    ],
    outputs: [
      { type: "uint256", name: "creditOut" },
      { type: "uint256", name: "usdgSpent" },
      { type: "uint256", name: "activationId" },
    ],
  },
  { name: "feeBps", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { name: "MAX_FILLS", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  /** Custom error seen on mainnet when the buyer's USDG balance is below usdgIn (selector 0x356680b7). */
  { name: "InsufficientFunds", type: "error", inputs: [] },
] as const;

/** CREDIT token: ERC-20 subset + activate / previewActivation */
export const creditAbi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "spender" },
      { type: "uint256", name: "amount" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { type: "address", name: "owner" },
      { type: "address", name: "spender" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address", name: "account" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "to" },
      { type: "uint256", name: "amount" },
    ],
    outputs: [{ type: "bool" }],
  },
  { name: "decimals", type: "function", stateMutability: "pure", inputs: [], outputs: [{ type: "uint8" }] },
  {
    name: "activate",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256", name: "amount" }],
    outputs: [{ type: "uint256", name: "activationId" }],
  },
  {
    name: "activate",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "amount" },
      { type: "bytes32", name: "beneficiary" },
    ],
    outputs: [{ type: "uint256", name: "activationId" }],
  },
  {
    name: "previewActivation",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "uint256", name: "amount" }],
    outputs: [
      { type: "uint256", name: "credited" },
      { type: "uint256", name: "feeAtoms" },
    ],
  },
  { name: "activationFeeBps", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  {
    name: "Activated",
    type: "event",
    inputs: [
      { type: "uint256", name: "activationId", indexed: true },
      { type: "address", name: "from", indexed: true },
      { type: "bytes32", name: "beneficiary", indexed: true },
      { type: "uint256", name: "amount" },
    ],
  },
  {
    name: "ActivationFeeCharged",
    type: "event",
    inputs: [
      { type: "uint256", name: "activationId", indexed: true },
      { type: "uint256", name: "feeAtoms" },
    ],
  },
] as const;

/** USDG is a plain ERC-20; the CREDIT ABI's ERC-20 subset covers it. */
export const erc20Abi = creditAbi;
