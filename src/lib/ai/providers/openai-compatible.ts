// OpenAI-compatible Chat Completions proxies (MIT Parley). No schema enforcement: the schema is
// stated in the system prompt and the reply is validated afterwards. Errors carry whether they were billed.
import "server-only";
import type { ModelCaps } from "../capabilities";
import type { AiConfig } from "../config";
import { outputCap } from "../pricing";
import { fromOpenAiCompatible } from "../usage";
import { AiError, billingForStatus, retryAfterSeconds, type JsonRequest, type ProviderResult } from "../types";

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
        [caps.tokenParam]: outputCap(req, cfg, caps.defaultMaxOutput),
        ...(caps.temperature ? { temperature: 0.7 } : {}),
      }),
    });
    if (!res.ok) throw new AiError("upstream", `HTTP ${res.status}`, { ...billingForStatus(res.status), status: res.status, retryAfterS: retryAfterSeconds(res.headers.get("retry-after")) });
    const body = (await res.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
    const usage = fromOpenAiCompatible(body, cfg.model);
    const choice = body.choices?.[0];
    if (choice?.finish_reason === "length") throw new AiError("bad_output", "reply was cut off (token limit)", { usage });
    return { text: choice?.message?.content ?? "", model: cfg.model, usage };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if ((e as Error).name === "AbortError") throw new AiError("timeout", "timed out", { billing: "unknown" });
    throw new AiError("upstream", (e as Error).message, { billing: "unknown" });
  } finally {
    clearTimeout(timer);
  }
}
