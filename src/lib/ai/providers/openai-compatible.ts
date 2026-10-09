// OpenAI-compatible Chat Completions proxies (MIT Parley). No schema enforcement: the schema is
// stated in the system prompt and the reply is validated afterwards.
import "server-only";
import type { ModelCaps } from "../capabilities";
import type { AiConfig } from "../config";
import { AiError, type JsonRequest, type ProviderResult } from "../types";

export async function callOpenAiCompatible(cfg: AiConfig, caps: ModelCaps, req: JsonRequest, fetchImpl: typeof fetch = fetch): Promise<ProviderResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 15_000);
  try {
    const system = `${req.system}\n\nReturn only a JSON object (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(req.schema)}`;
    const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "system", content: system }, ...req.messages],
        [caps.tokenParam]: req.maxOutputTokens ?? caps.defaultMaxOutput,
        ...(caps.temperature ? { temperature: 0.7 } : {}),
      }),
    });
    if (!res.ok) throw new AiError("upstream", `HTTP ${res.status}`);
    const body = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const usage = { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
    const choice = body.choices?.[0];
    if (choice?.finish_reason === "length") throw new AiError("bad_output", "reply was cut off (token limit)", usage);
    return { text: choice?.message?.content ?? "", model: cfg.model, usage };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if ((e as Error).name === "AbortError") throw new AiError("timeout");
    throw new AiError("upstream", (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
