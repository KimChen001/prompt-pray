// What a request can cost and what it did cost, in integer micro-USD (spec docs/ai-ledger-spec.md §6).
// Prices are integer nano-USD per token, per category: input, output (thinking included), cache writes
// (1.25x input for the 5-minute TTL, 2x for 1 hour) and cache reads (per model). Each attempt of a
// request — a refused attempt and the fallback that then served it — is priced at the model that ran
// it. The bound sums the primary attempt and every allowed fallback hop at its maximum, so an admitted
// request can never cost more than what was reserved for it.
import type { AiConfig } from "./config";
import type { JsonRequest, NormalizedUsage } from "./types";

export interface ModelPrice {
  inN: number;
  outN: number;
  cw5mN: number;
  cw1hN: number;
  crN: number;
}

const p = (inN: number, outN: number, crN: number): ModelPrice => ({ inN, outN, cw5mN: inN * 1.25, cw1hN: inN * 2, crN });

/** Checked against the claude-api reference (2026-09-25 cache); confirm on the pricing page before buying credit. */
export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": p(4000, 20000, 200),
  "claude-opus-5": p(5000, 25000, 500),
  "claude-opus-4-8": p(5000, 25000, 500),
  "claude-sonnet-5-5": p(2000, 10000, 200),
  "claude-sonnet-5": p(2000, 10000, 200),
  "claude-haiku-4-5": p(1000, 5000, 100),
  "claude-fable-5-1": p(10000, 50000, 250),
  "claude-fable-5": p(10000, 50000, 1000),
};

export function maxPrice(ps: ModelPrice[]): ModelPrice {
  return ps.reduce((a, b) => ({ inN: Math.max(a.inN, b.inN), outN: Math.max(a.outN, b.outN), cw5mN: Math.max(a.cw5mN, b.cw5mN), cw1hN: Math.max(a.cw1hN, b.cw1hN), crN: Math.max(a.crN, b.crN) }));
}

/** For a served model nobody priced: the component-wise maximum of the table and the old 15/60 estimate. */
export const PRICE_CEILING: ModelPrice = maxPrice([...Object.values(PRICE_TABLE), p(15000, 60000, 1500)]);

const FALLBACK_TARGETS: Record<string, string[]> = {
  "claude-opus-5-5": ["claude-opus-5", "claude-opus-4-8"],
  "claude-sonnet-5-5": ["claude-sonnet-5"],
  "claude-opus-5": ["claude-opus-4-8"],
  "claude-fable-5-1": ["claude-opus-4-8", "claude-opus-5"],
};

const tableKey = (model: string) => Object.keys(PRICE_TABLE).sort((a, b) => b.length - a.length).find((k) => model === k || model.startsWith(`${k}-`));

/** The price for a model: env overrides for the configured model, then the table, then the legacy proxy default or the ceiling. */
export function priceFor(cfg: AiConfig, model: string | null): { price: ModelPrice; known: boolean } {
  const m = model ?? cfg.model;
  const key = tableKey(m);
  const base = key ? PRICE_TABLE[key] : null;
  if (m === cfg.model && Object.keys(cfg.priceOverride).length) {
    const fallback = base ?? (cfg.provider === "openai-compatible" ? p(1000, 5000, 100) : PRICE_CEILING);
    const inN = cfg.priceOverride.inN ?? fallback.inN;
    return { price: { inN, outN: cfg.priceOverride.outN ?? fallback.outN, cw5mN: cfg.priceOverride.cw5mN ?? inN * 1.25, cw1hN: cfg.priceOverride.cw1hN ?? inN * 2, crN: cfg.priceOverride.crN ?? Math.ceil(inN * 0.1) }, known: true };
  }
  if (base) return { price: base, known: true };
  // Development proxy (Parley) models without a table entry: its own cheap estimate; anything else unknown.
  if (cfg.provider === "openai-compatible" && m === cfg.model) return { price: p(1000, 5000, 100), known: true };
  if (cfg.provider === "fake") return { price: priceFor({ ...cfg, provider: "anthropic", model: cfg.fakePriceAs, priceOverride: {} }, cfg.fakePriceAs).price, known: true };
  return { price: PRICE_CEILING, known: false };
}

/** Models a request may fall back to, when fallbacks are on and the model supports them. */
export function fallbackTargets(cfg: AiConfig): string[] {
  if (!cfg.fallbacks || cfg.provider !== "anthropic") return [];
  if (cfg.fallbackModels.length) return cfg.fallbackModels;
  const key = tableKey(cfg.model);
  return key ? FALLBACK_TARGETS[key] ?? [] : [];
}

/** What reported usage cost. Attempts without a model: the primary at the configured model, a fallback at the dearest target. */
export function costMicro(u: NormalizedUsage, cfg: AiConfig): { micro: number; unknownModels: string[] } {
  const unknownModels: string[] = [];
  const targets = fallbackTargets(cfg);
  let nano = 0;
  for (const a of u.attempts) {
    let price: ModelPrice;
    if (a.model) {
      const r = priceFor(cfg, a.model);
      if (!r.known) unknownModels.push(a.model);
      price = r.price;
    } else {
      price = a.kind === "fallback" && targets.length ? maxPrice(targets.map((t) => priceFor(cfg, t).price)) : priceFor(cfg, cfg.model).price;
    }
    nano += a.input * price.inN + a.cacheWrite5m * price.cw5mN + a.cacheWrite1h * price.cw1hN + a.cacheRead * price.crN + a.output * price.outN;
  }
  return { micro: Math.ceil(nano / 1000), unknownModels };
}

/** The output cap a request will be sent with: its own, else the purpose's configured cap, else the model default. */
export function outputCap(req: JsonRequest, cfg: AiConfig, modelDefault: number): number {
  return req.maxOutputTokens ?? (cfg.maxOutput as Record<string, number | undefined>)[req.purpose] ?? modelDefault;
}

/**
 * The most a request can cost, in micro-USD: primary attempt plus every allowed fallback hop, each
 * with the whole input (at least one token per UTF-8 byte, plus framing margin) and the full output cap.
 */
export function requestBoundMicro(req: JsonRequest, cfg: AiConfig, maxOutputTokens: number): number {
  const bytes = Buffer.byteLength(JSON.stringify({ system: req.system, messages: req.messages, schema: req.schema }), "utf8");
  const input = Math.ceil(bytes * cfg.tokensPerByte) + 2048;
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) throw new Error("invalid output cap");
  const targets = fallbackTargets(cfg);
  const hops = targets.length ? cfg.fallbackMaxHops : 0;
  const primary = priceFor(cfg, cfg.model).price;
  const fallback = targets.length ? maxPrice(targets.map((t) => priceFor(cfg, t).price)) : primary;
  let micro = 0;
  for (let i = 0; i <= hops; i++) {
    const pr = i === 0 ? primary : fallback;
    micro += Math.ceil((input * pr.inN + maxOutputTokens * pr.outN) / 1000);
  }
  return micro;
}
