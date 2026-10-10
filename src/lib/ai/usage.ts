// Provider usage → NormalizedUsage (spec §6). Anthropic reports one entry per attempt in
// `usage.iterations` (a refused attempt is "message", the fallback that served is "fallback_message");
// without it the top level is one attempt, and a served model other than the requested one can't be
// attributed, so the usage is marked incomplete and the request's bound is charged instead.
// OpenAI: reasoning tokens are inside completion_tokens (billed as output); cached prompt tokens are
// billed at the full input price (conservative). Missing usage is incomplete.
import type { Attempt, NormalizedUsage } from "./types";

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.ceil(v) : 0);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function anthropicAttempt(u: Record<string, unknown>, model: string | null, kind: Attempt["kind"]): Attempt {
  const cc = obj(u.cache_creation);
  const total = n(u.cache_creation_input_tokens);
  const w5 = cc ? n(cc.ephemeral_5m_input_tokens) : 0;
  let w1 = cc ? n(cc.ephemeral_1h_input_tokens) : 0;
  // Writes without a breakdown are priced at the dearer 1-hour rate.
  if (total > w5 + w1) w1 += total - (w5 + w1);
  return { model, kind, input: n(u.input_tokens), cacheWrite5m: w5, cacheWrite1h: w1, cacheRead: n(u.cache_read_input_tokens), output: n(u.output_tokens) };
}

export function fromAnthropic(res: unknown, requested: string): NormalizedUsage {
  const r = obj(res);
  const u = obj(r?.usage);
  const served = typeof r?.model === "string" ? r.model : requested;
  if (!u) return { attempts: [], servedModel: served, complete: false };
  const its = Array.isArray(u.iterations) ? u.iterations.map(obj) : null;
  if (its && its.length && its.every(Boolean)) {
    const attempts = its.map((it, i) => {
      const kind: Attempt["kind"] = it!.type === "fallback_message" ? "fallback" : "primary";
      const model = typeof it!.model === "string" ? it!.model : i === 0 && kind === "primary" ? requested : null;
      return anthropicAttempt(it!, model, kind);
    });
    return { attempts, servedModel: served, complete: true };
  }
  const attempt = anthropicAttempt(u, served, served === requested ? "primary" : "fallback");
  return { attempts: [attempt], servedModel: served, complete: served === requested };
}

function openAiStyle(body: unknown, requested: string, servedFromBody: boolean): NormalizedUsage {
  const b = obj(body);
  const u = obj(b?.usage);
  const served = servedFromBody && typeof b?.model === "string" ? b.model : requested;
  if (!u || typeof u.prompt_tokens !== "number" || typeof u.completion_tokens !== "number") return { attempts: [], servedModel: served, complete: false };
  return { attempts: [{ model: served, kind: "primary", input: n(u.prompt_tokens), cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: n(u.completion_tokens) }], servedModel: served, complete: true };
}

export function fromOpenAi(body: unknown, requested: string): NormalizedUsage {
  return openAiStyle(body, requested, true);
}

/** Proxies (Parley) may report their own model alias; billing follows the configured model. */
export function fromOpenAiCompatible(body: unknown, requested: string): NormalizedUsage {
  return openAiStyle(body, requested, false);
}

export function totalTokens(u: NormalizedUsage): number {
  return u.attempts.reduce((s, a) => s + a.input + a.cacheWrite5m + a.cacheWrite1h + a.cacheRead + a.output, 0);
}
