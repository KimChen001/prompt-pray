// Claude via the official Anthropic TypeScript SDK (Messages API).
// Claude 5.x: no sampling parameters, effort via output_config, native structured outputs, and the
// server-side refusal fallback (`fallbacks: "default"`) on by default (AI_FALLBACKS=off disables it).
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { ModelCaps } from "../capabilities";
import type { AiConfig } from "../config";
import { AiError, type JsonRequest, type ProviderResult } from "../types";

export async function callAnthropic(cfg: AiConfig, caps: ModelCaps, req: JsonRequest, fetchImpl?: typeof fetch): Promise<ProviderResult> {
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    timeout: req.timeoutMs ?? 30_000,
    maxRetries: 1,
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
      max_tokens: req.maxOutputTokens ?? caps.defaultMaxOutput,
      system,
      messages: req.messages,
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      ...(caps.temperature ? { temperature: 0.7 } : {}),
      ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    const u = res.usage;
    const usage = {
      inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
    };
    if (res.stop_reason === "refusal") throw new AiError("refused", "model declined", usage);
    if (res.stop_reason === "max_tokens") throw new AiError("bad_output", "reply was cut off (token limit)", usage);
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return { text, model: res.model, usage };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Anthropic.APIConnectionTimeoutError) throw new AiError("timeout");
    if (e instanceof Anthropic.APIError) throw new AiError("upstream", `HTTP ${e.status ?? "?"}`);
    throw new AiError("upstream", (e as Error).message);
  }
}
