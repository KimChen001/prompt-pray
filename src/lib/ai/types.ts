import type { ProviderKind } from "./capabilities";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Strict object schema (all properties required, no extras) — valid for both OpenAI strict mode and Anthropic. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

/** The five paid AI features; each has its own output cap and quota. */
export type Purpose = "tarot" | "chat" | "talk" | "natal" | "horoscope";
export const PURPOSES: readonly Purpose[] = ["tarot", "chat", "talk", "natal", "horoscope"];
export const isPurpose = (v: string): v is Purpose => (PURPOSES as readonly string[]).includes(v);

export interface JsonRequest {
  /** Short label for logs/metrics and per-purpose limits, e.g. "horoscope", "tarot". Never user content. */
  purpose: string;
  system: string;
  messages: ChatMessage[];
  schema: JsonSchema;
  schemaName: string;
  /** Output cap, thinking included. When omitted, the purpose's configured cap (or the model default) applies. */
  maxOutputTokens?: number;
  timeoutMs?: number;
}

/** One model attempt inside a request (a refused attempt and the fallback that served it are two). */
export interface Attempt {
  /** The model that ran this attempt; null when the provider didn't say. */
  model: string | null;
  kind: "primary" | "fallback";
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** Output tokens, thinking/reasoning included. */
  output: number;
}

/** Usage as billed. `complete: false` means it can't be trusted, so the request's bound is charged. */
export interface NormalizedUsage {
  attempts: Attempt[];
  servedModel: string;
  complete: boolean;
}

export interface ProviderResult {
  text: string;
  model: string; // the model that actually served the request (may differ after a fallback)
  usage: NormalizedUsage;
}

export interface GenerationMeta {
  provider: ProviderKind;
  model: string;
  generatedAt: string; // ISO instant
  costUsd: number;
}

/** What a client is told about a generated text. "simulated" = the offline fake provider, never "Live AI". */
export interface PublicMeta {
  provider: ProviderKind;
  model: string;
  generatedAt: string; // ISO instant
  source: "live" | "simulated";
}

export type AiErrorCode = "unconfigured" | "timeout" | "upstream" | "bad_output" | "refused" | "budget" | "ledger";

/**
 * Whether a failed request was billed:
 *   known   – usage was reported (refusal, truncation, bad JSON): charge it
 *   none    – the provider certainly didn't bill (4xx before any work, 429/529): charge nothing
 *   unknown – timeout, connection loss, 5xx: it may have been billed, so the hold is kept
 */
export type ErrorBilling = "known" | "none" | "unknown";

export class AiError extends Error {
  usage?: NormalizedUsage;
  billing: ErrorBilling;
  status?: number;
  rateLimited: boolean;
  retryAfterS?: number;
  constructor(
    public code: AiErrorCode,
    message?: string,
    opts: { usage?: NormalizedUsage; billing?: ErrorBilling; status?: number; rateLimited?: boolean; retryAfterS?: number } = {},
  ) {
    super(message ?? code);
    this.usage = opts.usage;
    this.billing = opts.billing ?? (opts.usage ? "known" : "unknown");
    this.status = opts.status;
    this.rateLimited = opts.rateLimited ?? false;
    this.retryAfterS = opts.retryAfterS;
  }
}

/** Billing class for an HTTP error status from a provider (the request never produced a reply). */
export function billingForStatus(status: number): { billing: ErrorBilling; rateLimited: boolean } {
  if (status === 429 || status === 529) return { billing: "none", rateLimited: true };
  if ([400, 401, 403, 404, 413, 422].includes(status)) return { billing: "none", rateLimited: false };
  return { billing: "unknown", rateLimited: false }; // 408, 5xx and anything unexpected
}

/** Seconds from a retry-after header (seconds or an HTTP date), capped at 120. */
export function retryAfterSeconds(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  const s = Number.isFinite(n) ? n : (Date.parse(v) - now) / 1000;
  return Number.isFinite(s) && s >= 0 ? Math.min(120, Math.ceil(s)) : undefined;
}
