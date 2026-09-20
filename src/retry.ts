import { CONSTANTS } from "./config.js";
import type { Logger } from "./logger.js";

/**
 * Retry with exponential backoff.
 * `abortIf` short-circuits retries for errors that will not go away (e.g. 404 no provider).
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  log: Logger,
  retries = CONSTANTS.MAX_RETRIES,
  abortIf: (err: unknown) => boolean = () => false,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (abortIf(err)) throw err;
      const e = err as { shortMessage?: string; message?: string };
      const msg = e?.shortMessage ?? (err instanceof Error ? err.message : String(err));
      log.warn(`${label} failed (attempt ${attempt}/${retries}): ${msg}`);
      if (attempt < retries) {
        await sleep(CONSTANTS.RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
