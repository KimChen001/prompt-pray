import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { modelCaps } from "@/lib/ai/capabilities";
import { aiConfig, type AiConfig } from "@/lib/ai/config";
import { Budget } from "@/lib/ai/budget";
import { AiError, extractJson, generateJson } from "@/lib/ai/provider";
import { HOROSCOPE_SCHEMA, horoscopePrompt, parseHoroscopeRequest, validateHoroscope } from "@/lib/ai/horoscope-prompt";
import { resetAiLimits } from "@/lib/ai/guard";
import { POST as horoscopePOST } from "@/app/api/ai/horoscope/route";
import { GET as statusGET } from "@/app/api/ai/status/route";
import type { JsonRequest } from "@/lib/ai/types";

const tmp = () => join(mkdtempSync(join(tmpdir(), "moona-ai-")), "usage.json");
const limits = { maxCallsPerDay: 100, maxUsdPerDay: 5, maxUsdTotal: 25 };
/** Builds config the way the server does (prices follow provider + model), with a test key. */
const cfgFor = (over: { provider?: string; model?: string; baseUrl?: string } = {}): AiConfig =>
  aiConfig({ AI_API_KEY: "test-key", AI_PROVIDER: over.provider, AI_MODEL: over.model, AI_BASE_URL: over.baseUrl });
const req: JsonRequest = { purpose: "test", system: "sys", messages: [{ role: "user", content: "hi" }], schema: HOROSCOPE_SCHEMA, schemaName: "horoscope" };
const good = { overall: "o", love: "l", work: "w" };
const valid = (d: unknown) => validateHoroscope(d);

const chatReply = (content: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ model: "m", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 200 }, ...extra }), { status: 200, headers: { "Content-Type": "application/json" } });
const claudeReply = (text: string, stop = "end_turn", model = "claude-opus-5-5") =>
  new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } });
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body));
const headerOf = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetAiLimits();
});

describe("model capabilities", () => {
  it("never sends sampling parameters to Claude 5.x and uses effort + structured outputs + fallbacks", () => {
    expect(modelCaps("anthropic", "claude-opus-5-5")).toMatchObject({ temperature: false, effort: "anthropic", structured: "anthropic", fallbacks: true });
    expect(modelCaps("anthropic", "claude-sonnet-5-5")).toMatchObject({ temperature: false, fallbacks: true });
  });
  it("keeps sampling for Haiku 4.5 and validates JSON afterwards", () => {
    expect(modelCaps("anthropic", "claude-haiku-4-5")).toMatchObject({ temperature: true, effort: null, structured: "none", fallbacks: false });
  });
  it("uses max_completion_tokens + reasoning effort for OpenAI reasoning models", () => {
    expect(modelCaps("openai", "gpt-5-mini")).toMatchObject({ temperature: false, tokenParam: "max_completion_tokens", effort: "openai_reasoning", structured: "openai_json_schema" });
    expect(modelCaps("openai", "gpt-4.1")).toMatchObject({ temperature: true, effort: null });
  });
  it("treats Claude 5.x behind an OpenAI-compatible proxy as no-sampling", () => {
    expect(modelCaps("openai-compatible", "claude-haiku-4-5").temperature).toBe(true);
    expect(modelCaps("openai-compatible", "claude-opus-5-5").temperature).toBe(false);
  });
});

describe("config", () => {
  it("defaults to the Parley proxy and reads caps and prices", () => {
    const c = aiConfig({ AI_API_KEY: "k" });
    expect(c).toMatchObject({ provider: "openai-compatible", baseUrl: "https://parley.api.mit.edu/v1", model: "claude-haiku-4-5", fallbacks: true });
    expect(aiConfig({ AI_PROVIDER: "anthropic" })).toMatchObject({ model: "claude-opus-5-5", prices: { input: 4, output: 20 } });
    expect(aiConfig({ AI_PROVIDER: "openai" }).model).toBe(""); // must be named explicitly
    expect(aiConfig({ AI_MAX_USD_TOTAL: "12", AI_FALLBACKS: "off" })).toMatchObject({ limits: { maxUsdTotal: 12 }, fallbacks: false });
  });
});

describe("provider request shapes (mocked network)", () => {
  it("OpenAI-compatible (Parley): plain chat completions, schema stated in the prompt", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatReply(JSON.stringify(good)));
    const { value } = await generateJson(req, valid, { cfg: cfgFor({}), budget: new Budget({ path: tmp(), durable: true }, limits), fetchImpl });
    expect(value).toEqual(good);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://parley.api.mit.edu/v1/chat/completions");
    const body = bodyOf(init);
    expect(body).toMatchObject({ model: "claude-haiku-4-5", max_tokens: 1500, temperature: 0.7 });
    expect(body.response_format).toBeUndefined();
    expect(body.messages[0].content).toContain('"additionalProperties":false');
  });

  it("OpenAI reasoning model: strict json_schema, max_completion_tokens, reasoning_effort, no temperature", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatReply(JSON.stringify(good)));
    await generateJson(req, valid, { cfg: cfgFor({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini" }), budget: new Budget({ path: tmp(), durable: true }, limits), fetchImpl });
    const body = bodyOf(fetchImpl.mock.calls[0][1]);
    expect(body).toMatchObject({ model: "gpt-5-mini", max_completion_tokens: 6000, reasoning_effort: "low", response_format: { type: "json_schema", json_schema: { name: "horoscope", strict: true } } });
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it("OpenAI refusal maps to 'refused'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: null, refusal: "no" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }), { status: 200 }));
    await expect(generateJson(req, valid, { cfg: cfgFor({ provider: "openai", model: "gpt-5-mini" }), budget: new Budget({ path: tmp(), durable: true }, limits), fetchImpl })).rejects.toMatchObject({ code: "refused" });
  });

  it("Claude Opus 5.5 via the SDK: effort + json_schema format + default fallbacks, no temperature", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(claudeReply(JSON.stringify(good)));
    const { value, meta } = await generateJson(req, valid, { cfg: cfgFor({ provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5" }), budget: new Budget({ path: tmp(), durable: true }, limits), fetchImpl });
    expect(value).toEqual(good);
    expect(meta).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    expect(headerOf(init, "x-api-key")).toBe("test-key");
    expect(headerOf(init, "anthropic-version")).toBeTruthy();
    expect(headerOf(init, "anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    const body = bodyOf(init);
    expect(body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "low", format: { type: "json_schema" } } });
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.betas).toBeUndefined(); // betas travel as a header, not in the body
  });

  it("Claude Haiku 4.5: temperature allowed, no output_config, no fallbacks", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(claudeReply("Here you go: " + JSON.stringify(good), "end_turn", "claude-haiku-4-5"));
    const { value } = await generateJson(req, valid, { cfg: cfgFor({ provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-haiku-4-5" }), budget: new Budget({ path: tmp(), durable: true }, limits), fetchImpl });
    expect(value).toEqual(good);
    const [, init] = fetchImpl.mock.calls[0];
    const body = bodyOf(init);
    expect(body.temperature).toBe(0.7);
    expect(body.output_config).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
    expect(headerOf(init, "anthropic-beta")).toBeNull();
  });

  it("Claude refusal and truncation are surfaced, and still billed", async () => {
    const file = tmp();
    const budget = new Budget({ path: file, durable: true }, limits);
    const cfg = cfgFor({ provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5" });
    await expect(generateJson(req, valid, { cfg, budget, fetchImpl: vi.fn().mockResolvedValue(claudeReply("", "refusal")) })).rejects.toMatchObject({ code: "refused" });
    await expect(generateJson(req, valid, { cfg, budget, fetchImpl: vi.fn().mockResolvedValue(claudeReply('{"overall":', "max_tokens")) })).rejects.toMatchObject({ code: "bad_output" });
    const snap = await budget.snapshot();
    expect(snap.callsToday).toBe(2);
    expect(snap.usdToday).toBeGreaterThan(0); // 2 × (1000 in, 300 out) at $4/$20 per MTok = $0.02
    expect(snap.usdToday).toBeCloseTo(0.02, 5);
  });
});

describe("persistent budget", () => {
  it("survives a restart (new instance, same file) and enforces the daily call cap", async () => {
    const file = tmp();
    const small = { ...limits, maxCallsPerDay: 3 };
    const a = new Budget({ path: file, durable: true }, small);
    expect(await a.reserve()).toBeNull();
    expect(await a.reserve()).toBeNull();
    const b = new Budget({ path: file, durable: true }, small); // "server restarted"
    expect(await b.reserve()).toBeNull();
    expect(await b.reserve()).toBe("daily_calls");
    expect(JSON.parse(readFileSync(file, "utf8")).totalCalls).toBe(3);
  });
  it("enforces daily and total USD caps", async () => {
    const file = tmp();
    const b = new Budget({ path: file, durable: true }, { maxCallsPerDay: 100, maxUsdPerDay: 1, maxUsdTotal: 1.5 });
    await b.reserve();
    await b.record(1.2);
    expect(await b.reserve()).toBe("daily_usd");
    const tomorrow = new Budget({ path: file, durable: true }, { maxCallsPerDay: 100, maxUsdPerDay: 1, maxUsdTotal: 1.5 }, () => new Date(Date.now() + 86400e3));
    expect(await tomorrow.reserve()).toBeNull();
    await tomorrow.record(0.4);
    expect(await tomorrow.reserve()).toBe("total_usd");
  });
  it("does not overshoot under concurrent requests", async () => {
    const b = new Budget({ path: tmp(), durable: true }, { ...limits, maxCallsPerDay: 10 });
    const results = await Promise.all(Array.from({ length: 25 }, () => b.reserve()));
    expect(results.filter((r) => r === null)).toHaveLength(10);
  });
  it("blocks generation once exhausted, without calling the provider", async () => {
    const fetchImpl = vi.fn();
    const budget = new Budget({ path: tmp(), durable: true }, { ...limits, maxCallsPerDay: 0 });
    await expect(generateJson(req, valid, { cfg: cfgFor({}), budget, fetchImpl })).rejects.toMatchObject({ code: "budget" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("parsing and validation", () => {
  it("extracts JSON from fenced or chatty replies", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => extractJson("no json here")).toThrow(AiError);
  });
  it("validates horoscope requests and output", () => {
    const body = { locale: "en", date: "2026-10-28", tone: "tension", subject: { sun: "Leo" }, facts: ["Mercury is retrograde."] };
    expect(parseHoroscopeRequest(body)).toMatchObject({ locale: "en" });
    expect(parseHoroscopeRequest({ ...body, facts: [] })).toBeNull();
    expect(horoscopePrompt(parseHoroscopeRequest({ ...body, locale: "zh" })!).system).toMatch(/Simplified Chinese/);
    expect(validateHoroscope(good)).toEqual(good);
    expect(validateHoroscope({ overall: "You may want to die today", love: "b", work: "c" })).toBeNull();
  });
  it("rejects output that fails validation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatReply('{"overall":"o"}'));
    await expect(generateJson(req, valid, { cfg: cfgFor({}), budget: new Budget({ path: tmp(), durable: true }, limits), fetchImpl })).rejects.toMatchObject({ code: "bad_output" });
  });
});

describe("routes", () => {
  const post = (body: unknown, cookie?: string) => new NextRequest("http://localhost/api/ai/horoscope", { method: "POST", body: JSON.stringify(body), headers: cookie ? { cookie } : {} });
  const get = (cookie?: string) => new NextRequest("http://localhost/api/ai/status", { headers: cookie ? { cookie } : {} });
  const body = { locale: "en", date: "2026-10-28", tone: "tension", subject: { sun: "Leo" }, facts: ["Mercury is retrograde."] };
  beforeEach(() => vi.stubEnv("AI_USAGE_FILE", tmp()));

  it("horoscope: 503 when unconfigured, locked without the code", async () => {
    vi.stubEnv("AI_API_KEY", "");
    expect((await horoscopePOST(post(body))).status).toBe(503);
    vi.stubEnv("AI_API_KEY", "k");
    vi.stubEnv("AI_ACCESS_CODE", "demo");
    expect(await (await horoscopePOST(post(body))).json()).toEqual({ code: "locked" });
  });
  it("horoscope: returns text with provider/model/time metadata", async () => {
    vi.stubEnv("AI_API_KEY", "k");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(chatReply(JSON.stringify(good))));
    const res = await horoscopePOST(post(body));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ...good, source: "live", meta: { provider: "openai-compatible", model: "claude-haiku-4-5" } });
    expect(Date.parse(json.meta.generatedAt)).not.toBeNaN();
  });
  it("status: hides details from locked clients, shows budget to the demo device", async () => {
    vi.stubEnv("AI_API_KEY", "");
    expect(await (await statusGET(get())).json()).toEqual({ available: false, reason: "unconfigured" });
    vi.stubEnv("AI_API_KEY", "k");
    vi.stubEnv("AI_ACCESS_CODE", "demo");
    expect(await (await statusGET(get())).json()).toEqual({ available: false, reason: "locked" });
    const open = await (await statusGET(get("moona-ai-access=demo"))).json();
    expect(open).toMatchObject({ available: true, provider: "openai-compatible", budget: { callsToday: 0, durable: true } });
    expect(JSON.stringify(open)).not.toContain("k\"");
  });
});
