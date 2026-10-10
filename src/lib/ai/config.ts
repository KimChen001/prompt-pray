// Server-only AI configuration from environment variables. Keys never reach the browser.
import "server-only";
import { defaultPrices, type ProviderKind } from "./capabilities";
import type { ModelPrice } from "./pricing";
import type { Purpose } from "./types";
import { isDeployed, type EnvLike } from "@/lib/host";

export type { EnvLike } from "@/lib/host";

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
  /** Models a fallback may run on (empty = the built-in table in pricing.ts). */
  fallbackModels: string[];
  /** How many fallback attempts a request's bound covers. */
  fallbackMaxHops: number;
  /** Input tokens assumed per UTF-8 byte when bounding a request (1.0 can't underestimate). */
  tokensPerByte: number;
  /** Output cap per purpose, thinking included. */
  maxOutput: Record<Purpose, number>;
  /** Env price overrides for the configured model, nano-USD per token. */
  priceOverride: Partial<ModelPrice>;
  /** The fake provider prices its simulated usage as this model. */
  fakePriceAs: string;
  /** Legacy file-ledger caps (local single-process development). */
  limits: BudgetLimits;
  /** USD per million tokens for the configured model (kept for the legacy budget and tests). */
  prices: { input: number; output: number };
}

const DEFAULT_BASE: Record<ProviderKind, string> = {
  "openai-compatible": "https://parley.api.mit.edu/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  fake: "",
};
const DEFAULT_MODEL: Record<ProviderKind, string> = {
  "openai-compatible": "claude-haiku-4-5", // MIT Parley's verified model
  openai: "", // no default: name the model you bought access to
  anthropic: "claude-opus-5-5",
  fake: "simulated",
};
export const DEFAULT_MAX_OUTPUT: Record<Purpose, number> = { tarot: 3000, chat: 1200, talk: 1200, natal: 5000, horoscope: 1500 };

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
const perMtok = (v: string | undefined) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v) * 1000) : undefined);

export function aiConfig(env: EnvLike = process.env): AiConfig {
  const provider = (["openai-compatible", "openai", "anthropic", "fake"] as const).find((p) => p === env.AI_PROVIDER) ?? "openai-compatible";
  const model = env.AI_MODEL || DEFAULT_MODEL[provider];
  const prices = defaultPrices(provider, model);
  const override: Partial<ModelPrice> = {};
  const inN = perMtok(env.AI_PRICE_INPUT_PER_MTOK), outN = perMtok(env.AI_PRICE_OUTPUT_PER_MTOK);
  const cw5mN = perMtok(env.AI_PRICE_CACHE_WRITE_5M_PER_MTOK), cw1hN = perMtok(env.AI_PRICE_CACHE_WRITE_1H_PER_MTOK), crN = perMtok(env.AI_PRICE_CACHE_READ_PER_MTOK);
  if (inN) override.inN = inN;
  if (outN) override.outN = outN;
  if (cw5mN) override.cw5mN = cw5mN;
  if (cw1hN) override.cw1hN = cw1hN;
  if (crN) override.crN = crN;
  const maxOutput = { ...DEFAULT_MAX_OUTPUT };
  for (const k of Object.keys(maxOutput) as Purpose[]) {
    const v = num(env[`AI_MAX_OUTPUT_${k.toUpperCase()}`], maxOutput[k]);
    if (Number.isInteger(v) && v > 0) maxOutput[k] = v;
  }
  return {
    provider,
    baseUrl: (env.AI_BASE_URL || DEFAULT_BASE[provider]).replace(/\/+$/, ""),
    apiKey: env.AI_API_KEY || "",
    model,
    accessCode: env.AI_ACCESS_CODE || "",
    fallbacks: env.AI_FALLBACKS !== "off",
    fallbackModels: (env.AI_FALLBACK_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    fallbackMaxHops: Math.max(0, Math.floor(num(env.AI_FALLBACK_MAX_HOPS, 1))),
    tokensPerByte: Math.min(1, Math.max(0.1, num(env.AI_INPUT_TOKENS_PER_BYTE, 1))),
    maxOutput,
    priceOverride: override,
    fakePriceAs: env.FAKE_AI_PRICE_AS || "claude-sonnet-5-5",
    limits: {
      maxCallsPerDay: num(env.AI_MAX_CALLS_PER_DAY, 300),
      maxUsdPerDay: num(env.AI_MAX_USD_PER_DAY, 5),
      maxUsdTotal: num(env.AI_MAX_USD_TOTAL, 25),
    },
    prices: { input: inN ? inN / 1000 : prices.input, output: outN ? outN / 1000 : prices.output },
  };
}

/**
 * Whether AI can run at all: a key and a model, or the offline fake provider (only off deployments,
 * or on a preview explicitly marked for rehearsal). The fake provider never produces "Live AI" labels.
 */
export function aiConfigured(cfg: AiConfig, env: EnvLike = process.env): boolean {
  if (cfg.provider === "fake") return !isDeployed(env) || env.AI_ALLOW_FAKE_ON_DEPLOY === "1";
  return !!cfg.apiKey && !!cfg.model;
}
