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

export interface JsonRequest {
  /** Short label for logs/metrics, e.g. "horoscope", "tarot". Never user content. */
  purpose: string;
  system: string;
  messages: ChatMessage[];
  schema: JsonSchema;
  schemaName: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface ProviderResult {
  text: string;
  model: string; // the model that actually served the request (may differ after a fallback)
  usage: { inputTokens: number; outputTokens: number };
}

export interface GenerationMeta {
  provider: ProviderKind;
  model: string;
  generatedAt: string; // ISO instant
  costUsd: number;
}

export type AiErrorCode = "unconfigured" | "timeout" | "upstream" | "bad_output" | "refused" | "budget";

export class AiError extends Error {
  constructor(public code: AiErrorCode, message?: string, public usage?: ProviderResult["usage"]) {
    super(message ?? code);
  }
}
