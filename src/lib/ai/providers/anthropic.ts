// Claude via the official Anthropic TypeScript SDK (Messages API).
// Claude 5.x: no sampling parameters, effort via output_config, native structured outputs, and the
// server-side refusal fallback (`fallbacks: "default"`) on by default (AI_FALLBACKS=off disables it).
// Usage is reported per attempt (usage.iterations), so a refused attempt and the fallback that served
// the reply are each priced at their own model. Errors carry whether they were billed.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { ModelCaps } from "../capabilities";
import type { AiConfig } from "../config";
import { outputCap } from "../pricing";
import { fromAnthropic } from "../usage";
import { AiError, billingForStatus, retryAfterSeconds, type JsonRequest, type ProviderResult } from "../types";

function header(e: unknown, name: string): string | null {
  const h = (e as { headers?: unknown }).headers;
  if (!h) return null;
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  const v = (h as Record<string, unknown>)[name];
  return typeof v === "string" ? v : null;
}

export async function callAnthropic(cfg: AiConfig, caps: ModelCaps, req: JsonRequest, fetchImpl?: typeof fetch): Promise<ProviderResult> {
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    timeout: req.timeoutMs ?? 30_000,
    maxRetries: 0, // One reservation covers one attempt; don't hide unaccounted SDK retries.
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  const system =
    caps.structured === "anthropic"
      ? req.system
      : `${req.system}\n\nReturn only a JSON object (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(req.schema)}`;
  const outputConfig = {
    ...(caps.effort === "anthropic" ? { effort: "low" as const } : {}),
    ...(caps.structured === "anthropic" ? { format: { type: "json_schema" as const, schema: req.schema as unknown as Record<string, unknown> } } : {}),
  };
  const useFallbacks = caps.fallbacks && cfg.fallbacks;

  try {
    const res = await client.beta.messages.create({
      model: cfg.model,
      max_tokens: outputCap(req, cfg, caps.defaultMaxOutput),
      system,
      messages: req.messages,
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      ...(caps.temperature ? { temperature: 0.7 } : {}),
      ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    const usage = fromAnthropic(res, cfg.model);
    if (res.stop_reason === "refusal") throw new AiError("refused", "model declined", { usage });
    if (res.stop_reason === "max_tokens") throw new AiError("bad_output", "reply was cut off (token limit)", { usage });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return { text, model: res.model, usage };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Anthropic.APIConnectionTimeoutError) throw new AiError("timeout", "timed out", { billing: "unknown" });
    if (e instanceof Anthropic.APIError && typeof e.status === "number") {
      const b = billingForStatus(e.status);
      throw new AiError("upstream", `HTTP ${e.status}`, { ...b, status: e.status, retryAfterS: retryAfterSeconds(header(e, "retry-after")) });
    }
    throw new AiError("upstream", (e as Error).message, { billing: "unknown" });
  }
}
