import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("wallet");

/**
 * WalletManager
 *  - holds the agent's Robinhood Chain account
 *  - derives the Orbio API key from a wallet signature (no registration call needed)
 *  - rotates the key by signing with a higher epoch
 *
 * Per Orbio docs:
 *   message = `Orbio API key · chain 4663 · epoch ${epoch}`
 *   apiKey  = `sk-orb-${epoch}-${base64(signatureBytes)}`
 * A new epoch is accepted on its first successful gateway request, which
 * invalidates keys from lower epochs. The key is held in memory only.
 */
export class WalletManager {
  readonly account: PrivateKeyAccount;
  readonly chain: Chain;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  private apiKey = "";
  private epoch: number;

  constructor(private readonly cfg: Config) {
    this.account = privateKeyToAccount(cfg.PRIVATE_KEY);
    this.epoch = cfg.ORBIO_KEY_EPOCH;
    this.chain = defineChain({
      id: cfg.CHAIN_ID,
      name: "Robinhood Chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [cfg.RPC_URL] } },
    });
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(cfg.RPC_URL) });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(cfg.RPC_URL),
    });
  }

  get address(): Address {
    return this.account.address;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  async ensureApiKey(): Promise<string> {
    if (!this.apiKey) this.apiKey = await this.deriveApiKey(this.epoch);
    return this.apiKey;
  }

  getApiKey(): string {
    if (!this.apiKey) throw new Error("API key not initialised; call ensureApiKey() first");
    return this.apiKey;
  }

  /** Signs the Orbio auth message for the given epoch and encodes the key. */
  async deriveApiKey(epoch: number): Promise<string> {
    const message = `Orbio API key · chain ${this.cfg.CHAIN_ID} · epoch ${epoch}`;
    const signature = await this.account.signMessage({ message });
    const key = `sk-orb-${epoch}-${Buffer.from(signature.slice(2), "hex").toString("base64")}`;
    log.info(`Derived API key for ${this.account.address} (epoch ${epoch}, …${key.slice(-6)})`);
    return key;
  }

  /**
   * Rotate: derive a key for epoch+1. It becomes active (and the old one
   * invalid) once the gateway accepts a request with it. Persist the new epoch
   * in ORBIO_KEY_EPOCH so future runs use it.
   */
  async rotateApiKey(): Promise<{ key: string; epoch: number }> {
    this.epoch += 1;
    this.apiKey = await this.deriveApiKey(this.epoch);
    log.warn(`Rotated to epoch ${this.epoch}. Set ORBIO_KEY_EPOCH=${this.epoch} in .env to keep using it.`);
    return { key: this.apiKey, epoch: this.epoch };
  }
}
