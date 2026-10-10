// Single entry point for AI generation: config → budget reservation of the request's bound → provider
// adapter (params from the capability table) → settle what was actually billed → JSON parse →
// caller's validation. Billing follows the error class: "none" settles 0, "known" settles the reported
// usage (priced per attempt at the model that ran it), "unknown" keeps the hold.
import "server-only";
import { modelCaps, type ModelCaps } from "./capabilities";
import { aiConfig, aiConfigured, type AiConfig } from "./config";
import { Budget, usageFilePath } from "./budget";
import { costMicro, outputCap, requestBoundMicro } from "./pricing";
import { callAnthropic } from "./providers/anthropic";
import { callOpenAi } from "./providers/openai";
import { callOpenAiCompatible } from "./providers/openai-compatible";
import { callFake, fakeScriptFromEnv, type FakeScript } from "./providers/fake";
import { AiError, type GenerationMeta, type JsonRequest, type NormalizedUsage, type ProviderResult } from "./types";

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

/** The reply as JSON: strict when the provider enforced a schema, extracted otherwise. */
export function parseReply(text: string, caps: ModelCaps): unknown {
  if (caps.structured === "none") return extractJson(text);
  try {
    return JSON.parse(text);
  } catch {
    return extractJson(text); // schema mode should give clean JSON; fall back defensively
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
  fake?: FakeScript;
}

/** The request with its output cap fixed (its own, the purpose's, or the model default). */
export function sizeRequest(req: JsonRequest, cfg: AiConfig): JsonRequest {
  return { ...req, maxOutputTokens: outputCap(req, cfg, modelCaps(cfg.provider, cfg.model).defaultMaxOutput) };
}

/** USD bound for a request as generateJson will send it (legacy name; micro-USD in pricing.ts). */
export function requestCostBound(req: JsonRequest, cfg: AiConfig): number {
  const sized = sizeRequest(req, cfg);
  return requestBoundMicro(sized, cfg, sized.maxOutputTokens!) / 1e6;
}

// Per-call fake scripts, rebuilt when the FAKE_AI_* settings change (a rehearsal can switch usage modes).
let fakeScripts: { key: string; next: () => FakeScript } | null = null;
function nextFakeScript(): FakeScript {
  const env = process.env;
  const key = [env.FAKE_AI_FAILURES, env.FAKE_AI_USAGE, env.FAKE_AI_LATENCY_MS].join("|");
  if (fakeScripts?.key !== key) fakeScripts = { key, next: fakeScriptFromEnv(env) };
  return fakeScripts.next();
}

export async function callProvider(req: JsonRequest, cfg: AiConfig, deps: { fetchImpl?: typeof fetch; fake?: FakeScript } = {}): Promise<ProviderResult> {
  const caps = modelCaps(cfg.provider, cfg.model);
  if (cfg.provider === "fake") return callFake(cfg, caps, req, deps.fake ?? nextFakeScript());
  if (cfg.provider === "anthropic") return callAnthropic(cfg, caps, req, deps.fetchImpl);
  if (cfg.provider === "openai") return callOpenAi(cfg, caps, req, deps.fetchImpl);
  return callOpenAiCompatible(cfg, caps, req, deps.fetchImpl);
}

/** What to charge for reported usage: its cost when complete, otherwise the request's whole bound. */
export function chargeMicro(usage: NormalizedUsage, cfg: AiConfig, boundMicro: number): number {
  return usage.complete && usage.attempts.length ? costMicro(usage, cfg).micro : boundMicro;
}

export async function generateJson<T>(req: JsonRequest, validate: (data: unknown) => T | null, deps: GenerateDeps = {}): Promise<{ value: T; meta: GenerationMeta }> {
  const cfg = deps.cfg ?? aiConfig();
  if (!aiConfigured(cfg)) throw new AiError("unconfigured");
  const caps = modelCaps(cfg.provider, cfg.model);
  // Defence in depth (guard.ts checks first): never spend without a ledger every instance shares.
  if (!deps.budget && !usageFilePath().durable) throw new AiError("ledger", "no shared ledger");
  const budget = deps.budget ?? budgetFor(cfg);

  const sized = sizeRequest(req, cfg);
  const boundMicro = requestBoundMicro(sized, cfg, sized.maxOutputTokens!);
  const reservation = await budget.reserveRequest(boundMicro / 1e6);
  if (typeof reservation === "string") throw new AiError("budget", reservation);

  let result: ProviderResult;
  try {
    result = await callProvider(sized, cfg, deps);
  } catch (e) {
    if (e instanceof AiError) {
      if (e.billing === "none") await budget.settle(reservation, 0); // certainly not billed: give the money back
      else if (e.billing === "known" && e.usage) await budget.settle(reservation, chargeMicro(e.usage, cfg, boundMicro) / 1e6); // billed even though unusable
    } // A timeout / unknown billing keeps its durable hold rather than restoring spend capacity.
    throw e;
  }
  const charged = chargeMicro(result.usage, cfg, boundMicro);
  await budget.settle(reservation, charged / 1e6);

  const data = parseReply(result.text, caps);
  const value = validate(data);
  if (value === null) throw new AiError("bad_output", "reply failed validation", { usage: result.usage });
  return { value, meta: { provider: cfg.provider, model: result.model, generatedAt: new Date().toISOString(), costUsd: +(charged / 1e6).toFixed(6) } };
}
