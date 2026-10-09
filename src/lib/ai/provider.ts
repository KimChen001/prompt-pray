// Server-only LLM access through an OpenAI-compatible endpoint (default: MIT Parley).
// The key lives in server env vars and never reaches the browser.
import "server-only";

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  accessCode: string; // when set, only clients that present this code may use AI
}

export function aiConfig(): AiConfig {
  return {
    baseUrl: (process.env.AI_BASE_URL || "https://parley.api.mit.edu/v1").replace(/\/+$/, ""),
    apiKey: process.env.AI_API_KEY || "",
    model: process.env.AI_MODEL || "claude-haiku-4-5",
    accessCode: process.env.AI_ACCESS_CODE || "",
  };
}

export class AiError extends Error {
  constructor(public code: "unconfigured" | "timeout" | "upstream" | "bad_output", message?: string) {
    super(message ?? code);
  }
}

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

export async function chatJson(opts: { system: string; user: string; maxTokens?: number; timeoutMs?: number }, cfg: AiConfig = aiConfig()): Promise<{ data: unknown; model: string }> {
  if (!cfg.apiKey) throw new AiError("unconfigured");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: opts.maxTokens ?? 700,
        temperature: 0.7,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
    });
    if (!res.ok) throw new AiError("upstream", `HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; model?: string };
    const content = body.choices?.[0]?.message?.content ?? "";
    return { data: extractJson(content), model: cfg.model };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if ((e as Error).name === "AbortError") throw new AiError("timeout");
    throw new AiError("upstream", (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
