// What each provider/model accepts. Request parameters are built from this table, never assumed.
// Sources: Anthropic model docs (Claude 5.x models reject non-default sampling parameters, run
// thinking that can't be turned off, and take `output_config.effort`); OpenAI reasoning models
// (gpt-5*, o*) take `max_completion_tokens`, `reasoning_effort` and no `temperature`.
export type ProviderKind = "openai-compatible" | "openai" | "anthropic" | "fake";

export interface ModelCaps {
  /** Send `temperature` at all. */
  temperature: boolean;
  tokenParam: "max_tokens" | "max_completion_tokens";
  /** How to ask for schema-constrained JSON; "none" = prompt for JSON and validate after. */
  structured: "anthropic" | "openai_json_schema" | "none";
  effort: "anthropic" | "openai_reasoning" | null;
  /** Anthropic server-side refusal fallback (`fallbacks: "default"`). */
  fallbacks: boolean;
  /** Output-token headroom; thinking/reasoning tokens count against it. */
  defaultMaxOutput: number;
}

const CLAUDE_5 = /^claude-(opus-5|sonnet-5|fable-5|mythos-5)/; // includes 5-5, 5-1 etc.
const CLAUDE_FALLBACKS = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/;
const OPENAI_REASONING = /^(gpt-5|o\d)/;

export function modelCaps(provider: ProviderKind, model: string): ModelCaps {
  // The offline fake provider (providers/fake.ts): JSON validated afterwards, like a proxy.
  if (provider === "fake") return { temperature: false, tokenParam: "max_tokens", structured: "none", effort: null, fallbacks: false, defaultMaxOutput: 1500 };
  if (provider === "anthropic") {
    if (CLAUDE_5.test(model)) {
      return { temperature: false, tokenParam: "max_tokens", structured: "anthropic", effort: "anthropic", fallbacks: CLAUDE_FALLBACKS.test(model), defaultMaxOutput: 8000 };
    }
    // Haiku 4.5 and older: sampling allowed, no effort; JSON via prompt + validation.
    return { temperature: true, tokenParam: "max_tokens", structured: "none", effort: null, fallbacks: false, defaultMaxOutput: 2000 };
  }
  if (provider === "openai") {
    if (OPENAI_REASONING.test(model)) {
      return { temperature: false, tokenParam: "max_completion_tokens", structured: "openai_json_schema", effort: "openai_reasoning", fallbacks: false, defaultMaxOutput: 6000 };
    }
    return { temperature: true, tokenParam: "max_completion_tokens", structured: "openai_json_schema", effort: null, fallbacks: false, defaultMaxOutput: 2000 };
  }
  // OpenAI-compatible proxies (MIT Parley). Plain chat completions; Claude 5.x behind a proxy still
  // rejects sampling parameters.
  return { temperature: !CLAUDE_5.test(model), tokenParam: "max_tokens", structured: "none", effort: null, fallbacks: false, defaultMaxOutput: 1500 };
}

/** USD per million tokens (input/output) for the legacy budget and display; the full table is pricing.ts. */
export function defaultPrices(provider: ProviderKind, model: string): { input: number; output: number } {
  const table: [RegExp, number, number][] = [
    [/claude-haiku-4-5/, 1, 5],
    [/claude-sonnet-5(-5)?$/, 2, 10],
    [/claude-opus-5-5/, 4, 20],
    [/claude-opus-(5|4-8)$/, 5, 25],
    [/claude-fable-5/, 10, 50],
  ];
  for (const [re, input, output] of table) if (re.test(model)) return { input, output };
  if (provider === "fake") return { input: 2, output: 10 }; // priced as Sonnet 5.5 by default
  return provider === "openai-compatible" ? { input: 1, output: 5 } : { input: 15, output: 60 };
}
