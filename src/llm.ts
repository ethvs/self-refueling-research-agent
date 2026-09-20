import OpenAI from "openai";
import type { Config } from "./config.js";
import { createLogger } from "./logger.js";
import { withRetry } from "./retry.js";

const log = createLogger("llm");

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

interface CompleteOpts {
  system: string;
  user: string;
  tier?: "cheap" | "search" | "strong";
  json?: boolean;
  maxTokens?: number;
}

/** Fallbacks used when the configured model has no provider serving it (404). */
const CHEAP_FALLBACKS = ["openai/gpt-4o-mini", "google/gemini-2.5-flash-lite", "deepseek/deepseek-chat"];
const SEARCH_FALLBACKS = ["perplexity/sonar", "perplexity/sonar-pro", "openai/gpt-4o-mini"];
const STRONG_FALLBACKS = ["anthropic/claude-sonnet-4.5", "openai/gpt-4o", "google/gemini-2.5-pro"];

/** Thin wrapper over the OpenAI-compatible Orbio gateway with usage accounting. */
export class OrbioLLM {
  private client: OpenAI;
  readonly usage: Usage = { calls: 0, promptTokens: 0, completionTokens: 0 };

  constructor(
    private readonly cfg: Config,
    apiKey: string,
  ) {
    this.client = new OpenAI({ apiKey, baseURL: cfg.ORBIO_API_BASE });
  }

  setApiKey(apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: this.cfg.ORBIO_API_BASE });
  }

  /** GET /api/v1/models → model ids (OpenRouter-style, e.g. anthropic/claude-sonnet-4.5). */
  async listModels(): Promise<string[]> {
    const page = await this.client.models.list();
    return page.data.map((m) => m.id).sort();
  }

  async complete(opts: CompleteOpts): Promise<string> {
    const tier = opts.tier ?? "cheap";
    const primary = tier === "strong" ? this.cfg.STRONG_MODEL : tier === "search" ? this.cfg.SEARCH_MODEL : this.cfg.CHEAP_MODEL;
    const pool = tier === "strong" ? STRONG_FALLBACKS : tier === "search" ? SEARCH_FALLBACKS : CHEAP_FALLBACKS;
    const fallbacks = pool.filter((m) => m !== primary);
    let lastErr: unknown;
    for (const model of [primary, ...fallbacks]) {
      try {
        return await withRetry(`chat(${model})`, () => this.callOnce(model, opts), log, 3, (e) => isNoProvider(e) || isInsufficientBalance(e));
      } catch (err) {
        lastErr = err;
        if (!isNoProvider(err)) throw err;
        log.warn(`${model}: no provider currently serving it, trying fallback`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async callOnce(model: string, opts: CompleteOpts): Promise<string> {
    const res = await this.client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      temperature: 0.2,
      max_tokens: opts.maxTokens ?? 1500,
      ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
    });
    this.usage.calls++;
    this.usage.promptTokens += res.usage?.prompt_tokens ?? 0;
    this.usage.completionTokens += res.usage?.completion_tokens ?? 0;
    log.debug(`${model}: ${res.usage?.prompt_tokens ?? "?"}+${res.usage?.completion_tokens ?? "?"} tokens`);
    let text = res.choices[0]?.message?.content ?? "";
    // Perplexity-style responses carry citation URLs out of band; append them so the report keeps real sources.
    const citations = (res as unknown as { citations?: string[] }).citations;
    if (Array.isArray(citations) && citations.length) {
      text += "\n\n引用链接：\n" + citations.map((u, i) => `[${i + 1}] ${u}`).join("\n");
    }
    return text;
  }
}

function isNoProvider(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e?.status === 404 || /no provider/i.test(e?.message ?? "");
}

/** The gateway refused the call because the key's activated balance is exhausted (HTTP 402 or an explicit message). */
export function isInsufficientBalance(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e?.status === 402 || /insufficient (balance|credit|funds)|payment required|balance (is )?too low|out of credit/i.test(e?.message ?? "");
}
