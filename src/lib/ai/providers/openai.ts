// OpenAI Chat Completions with JSON Schema structured outputs (strict). Reasoning models get
// `reasoning_effort` and no `temperature`. Schema conformance is not content correctness: callers
// still validate facts.
import "server-only";
import type { ModelCaps } from "../capabilities";
import type { AiConfig } from "../config";
import { AiError, type JsonRequest, type ProviderResult } from "../types";

export async function callOpenAi(cfg: AiConfig, caps: ModelCaps, req: JsonRequest, fetchImpl: typeof fetch = fetch): Promise<ProviderResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 20_000);
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "system", content: req.system }, ...req.messages],
        [caps.tokenParam]: req.maxOutputTokens ?? caps.defaultMaxOutput,
        response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
        ...(caps.effort === "openai_reasoning" ? { reasoning_effort: "low" } : {}),
        ...(caps.temperature ? { temperature: 0.7 } : {}),
      }),
    });
    if (!res.ok) throw new AiError("upstream", `HTTP ${res.status}`);
    const body = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const usage = { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
    const choice = body.choices?.[0];
    if (choice?.message?.refusal) throw new AiError("refused", "model refused", usage);
    if (choice?.finish_reason === "length") throw new AiError("bad_output", "reply was cut off (token limit)", usage);
    return { text: choice?.message?.content ?? "", model: body.model ?? cfg.model, usage };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if ((e as Error).name === "AbortError") throw new AiError("timeout");
    throw new AiError("upstream", (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
