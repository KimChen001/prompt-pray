// Single entry point for AI generation: config → budget reservation → provider adapter (params
// from the capability table) → cost recording → JSON parse → caller's validation.
import "server-only";
import { modelCaps } from "./capabilities";
import { aiConfig, type AiConfig } from "./config";
import { Budget, costUsd, usageFilePath } from "./budget";
import { callAnthropic } from "./providers/anthropic";
import { callOpenAi } from "./providers/openai";
import { callOpenAiCompatible } from "./providers/openai-compatible";
import { AiError, type GenerationMeta, type JsonRequest, type ProviderResult } from "./types";

export { AiError } from "./types";

/** Pulls the first JSON object out of a model reply (models sometimes wrap JSON in prose or fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AiError("bad_output", "no JSON object in reply");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AiError("bad_output", "reply JSON did not parse");
  }
}

const budgets = new Map<string, Budget>();
export function budgetFor(cfg: AiConfig): Budget {
  const file = usageFilePath();
  const key = `${file.path}|${JSON.stringify(cfg.limits)}`;
  if (!budgets.has(key)) budgets.set(key, new Budget(file, cfg.limits));
  return budgets.get(key)!;
}

export interface GenerateDeps {
  cfg?: AiConfig;
  budget?: Budget;
  fetchImpl?: typeof fetch;
}

/** Conservative token bound: UTF-8 bytes, schema, message framing, and maximum output. */
export function requestCostBound(req: JsonRequest, cfg: AiConfig): number {
  const caps = modelCaps(cfg.provider, cfg.model);
  const input = Buffer.byteLength(JSON.stringify({ system: req.system, messages: req.messages, schema: req.schema }), "utf8") + 2048;
  const output = req.maxOutputTokens ?? caps.defaultMaxOutput;
  if (!Number.isFinite(output) || output <= 0 || !Number.isFinite(cfg.prices.input) || cfg.prices.input <= 0 || !Number.isFinite(cfg.prices.output) || cfg.prices.output <= 0) {
    throw new AiError("budget", "invalid token budget or prices");
  }
  return Math.ceil(costUsd({ inputTokens: input, outputTokens: output }, cfg.prices) * 1_000_000) / 1_000_000;
}

export async function generateJson<T>(req: JsonRequest, validate: (data: unknown) => T | null, deps: GenerateDeps = {}): Promise<{ value: T; meta: GenerationMeta }> {
  const cfg = deps.cfg ?? aiConfig();
  if (!cfg.apiKey || !cfg.model) throw new AiError("unconfigured");
  const caps = modelCaps(cfg.provider, cfg.model);
  const budget = deps.budget ?? budgetFor(cfg);

  const reservation = await budget.reserveRequest(requestCostBound(req, cfg));
  if (typeof reservation === "string") throw new AiError("budget", reservation);

  let result: ProviderResult;
  try {
    result =
      cfg.provider === "anthropic" ? await callAnthropic(cfg, caps, req, deps.fetchImpl) :
      cfg.provider === "openai" ? await callOpenAi(cfg, caps, req, deps.fetchImpl) :
      await callOpenAiCompatible(cfg, caps, req, deps.fetchImpl);
  } catch (e) {
    if (e instanceof AiError && e.usage && e.usage.inputTokens + e.usage.outputTokens > 0) {
      await budget.settle(reservation, costUsd(e.usage, cfg.prices)); // billed even though unusable
    } // A timeout / unknown usage keeps its durable hold rather than restoring spend capacity.
    throw e;
  }
  const cost = costUsd(result.usage, cfg.prices);
  if (result.usage.inputTokens + result.usage.outputTokens > 0) await budget.settle(reservation, cost);

  const data = caps.structured === "none" ? extractJson(result.text) : parseStrict(result.text);
  const value = validate(data);
  if (value === null) throw new AiError("bad_output", "reply failed validation");
  return { value, meta: { provider: cfg.provider, model: result.model, generatedAt: new Date().toISOString(), costUsd: +cost.toFixed(6) } };
}

function parseStrict(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return extractJson(text); // schema mode should give clean JSON; fall back defensively
  }
}
