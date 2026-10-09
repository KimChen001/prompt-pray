// Server-only AI configuration from environment variables. Keys never reach the browser.
import "server-only";
import { defaultPrices, type ProviderKind } from "./capabilities";

export interface BudgetLimits {
  maxCallsPerDay: number;
  maxUsdPerDay: number;
  maxUsdTotal: number;
}

export interface AiConfig {
  provider: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  accessCode: string;
  /** Anthropic only: server-side refusal fallback. On by default; AI_FALLBACKS=off disables. */
  fallbacks: boolean;
  limits: BudgetLimits;
  prices: { input: number; output: number };
}

const DEFAULT_BASE: Record<ProviderKind, string> = {
  "openai-compatible": "https://parley.api.mit.edu/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};
const DEFAULT_MODEL: Record<ProviderKind, string> = {
  "openai-compatible": "claude-haiku-4-5", // MIT Parley's verified model
  openai: "", // no default: name the model you bought access to
  anthropic: "claude-opus-5-5",
};

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export type EnvLike = Record<string, string | undefined>;

export function aiConfig(env: EnvLike = process.env): AiConfig {
  const provider = (["openai-compatible", "openai", "anthropic"] as const).find((p) => p === env.AI_PROVIDER) ?? "openai-compatible";
  const model = env.AI_MODEL || DEFAULT_MODEL[provider];
  const prices = defaultPrices(provider, model);
  return {
    provider,
    baseUrl: (env.AI_BASE_URL || DEFAULT_BASE[provider]).replace(/\/+$/, ""),
    apiKey: env.AI_API_KEY || "",
    model,
    accessCode: env.AI_ACCESS_CODE || "",
    fallbacks: env.AI_FALLBACKS !== "off",
    limits: {
      maxCallsPerDay: num(env.AI_MAX_CALLS_PER_DAY, 300),
      maxUsdPerDay: num(env.AI_MAX_USD_PER_DAY, 5),
      maxUsdTotal: num(env.AI_MAX_USD_TOTAL, 25),
    },
    prices: { input: num(env.AI_PRICE_INPUT_PER_MTOK, prices.input), output: num(env.AI_PRICE_OUTPUT_PER_MTOK, prices.output) },
  };
}
