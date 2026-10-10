// Spec docs/ai-ledger-spec.md §6 (session S1): prices per category and per attempt, bounds that cover
// fallback hops, error billing classes, and the offline fake provider.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aiConfig, aiConfigured } from "@/lib/ai/config";
import { Budget } from "@/lib/ai/budget";
import { costMicro, fallbackTargets, maxPrice, PRICE_CEILING, PRICE_TABLE, priceFor, requestBoundMicro } from "@/lib/ai/pricing";
import { fromAnthropic, fromOpenAi, fromOpenAiCompatible } from "@/lib/ai/usage";
import { callProvider, generateJson, requestCostBound, sizeRequest } from "@/lib/ai/provider";
import { callFake, fakeScriptFromEnv } from "@/lib/ai/providers/fake";
import { modelCaps } from "@/lib/ai/capabilities";
import { AiError, billingForStatus, retryAfterSeconds, type JsonRequest, type NormalizedUsage } from "@/lib/ai/types";
import { HOROSCOPE_SCHEMA, horoscopePrompt, parseHoroscopeRequest, validateHoroscope } from "@/lib/ai/horoscope-prompt";
import { parseTarotRequest, tarotPrompt, TAROT_SCHEMA, validateTarot } from "@/lib/ai/tarot-prompt";
import { chatPrompt, CHAT_SCHEMA, parseChatRequest, validateChat } from "@/lib/ai/chat-prompt";
import { parseTalkRequest, talkContext, talkPrompt, TALK_SCHEMA, validateTalk } from "@/lib/ai/talk-prompt";
import { dayHoroscope, horoscopeBody } from "@/lib/astro/horoscope-day";

afterEach(() => vi.unstubAllEnvs());

const anthropic = (model: string, extra: Record<string, string> = {}) => aiConfig({ AI_PROVIDER: "anthropic", AI_API_KEY: "k", AI_MODEL: model, ...extra });
const req: JsonRequest = { purpose: "horoscope", system: "sys", messages: [{ role: "user", content: "hi" }], schema: HOROSCOPE_SCHEMA, schemaName: "horoscope" };
const attempt = (model: string | null, kind: "primary" | "fallback", input: number, output: number, extra: Partial<{ cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }> = {}) =>
  ({ model, kind, input, output, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, ...extra });

describe("price table", () => {
  it("prices every category per model; cache writes at 1.25x / 2x input", () => {
    expect(PRICE_TABLE["claude-opus-5-5"]).toEqual({ inN: 4000, outN: 20000, cw5mN: 5000, cw1hN: 8000, crN: 200 });
    expect(PRICE_TABLE["claude-sonnet-5-5"]).toEqual({ inN: 2000, outN: 10000, cw5mN: 2500, cw1hN: 4000, crN: 200 });
    expect(PRICE_TABLE["claude-fable-5-1"].crN).toBe(250);
    expect(PRICE_TABLE["claude-fable-5"].crN).toBe(1000);
  });
  it("prices an unknown served model at the component-wise ceiling", () => {
    expect(PRICE_CEILING).toEqual({ inN: 15000, outN: 60000, cw5mN: 18750, cw1hN: 30000, crN: 1500 });
    expect(maxPrice([PRICE_TABLE["claude-fable-5-1"], PRICE_TABLE["claude-opus-5"]]).crN).toBe(500);
    expect(priceFor(anthropic("claude-opus-5-5"), "claude-mystery-9")).toEqual({ price: PRICE_CEILING, known: false });
  });
  it("applies env price overrides to the configured model only, with derived cache rates", () => {
    const cfg = anthropic("claude-sonnet-5-5", { AI_PRICE_INPUT_PER_MTOK: "3", AI_PRICE_OUTPUT_PER_MTOK: "15" });
    expect(priceFor(cfg, "claude-sonnet-5-5").price).toEqual({ inN: 3000, outN: 15000, cw5mN: 3750, cw1hN: 6000, crN: 300 });
    expect(priceFor(cfg, "claude-sonnet-5").price).toEqual(PRICE_TABLE["claude-sonnet-5"]);
    expect(cfg.prices).toEqual({ input: 3, output: 15 });
  });
});

describe("fallback-aware costs and bounds", () => {
  it("knows which models a request may fall back to", () => {
    expect(fallbackTargets(anthropic("claude-opus-5-5"))).toEqual(["claude-opus-5", "claude-opus-4-8"]);
    expect(fallbackTargets(anthropic("claude-sonnet-5-5"))).toEqual(["claude-sonnet-5"]);
    expect(fallbackTargets(anthropic("claude-haiku-4-5"))).toEqual([]);
    expect(fallbackTargets(anthropic("claude-opus-5-5", { AI_FALLBACKS: "off" }))).toEqual([]);
    expect(fallbackTargets(aiConfig({ AI_API_KEY: "k", AI_MODEL: "claude-opus-5-5" }))).toEqual([]); // proxies don't run server-side fallbacks
    expect(fallbackTargets(anthropic("claude-opus-5-5", { AI_FALLBACK_MODELS: "claude-opus-4-8" }))).toEqual(["claude-opus-4-8"]);
  });
  it("prices each attempt at the model that ran it (a refused Opus 5.5 attempt and its Opus 5 rescue)", () => {
    const cfg = anthropic("claude-opus-5-5");
    const u: NormalizedUsage = { attempts: [attempt("claude-opus-5-5", "primary", 1000, 10), attempt("claude-opus-5", "fallback", 1000, 500)], servedModel: "claude-opus-5", complete: true };
    // (1000*4000 + 10*20000) + (1000*5000 + 500*25000) nano = 4.2e6 + 17.5e6 = 21.7e6 nano = 21700 micro
    expect(costMicro(u, cfg)).toEqual({ micro: 21700, unknownModels: [] });
    // Old behaviour priced everything at the requested model: 2000*4000 + 510*20000 = 18.2e6 nano. The fallback cost more.
  });
  it("prices cache writes and reads by kind, and attempts without a model conservatively", () => {
    const cfg = anthropic("claude-opus-5-5");
    const u: NormalizedUsage = { attempts: [attempt("claude-opus-5-5", "primary", 100, 100, { cacheWrite5m: 1000, cacheWrite1h: 1000, cacheRead: 10000 })], servedModel: "claude-opus-5-5", complete: true };
    expect(costMicro(u, cfg).micro).toBe(Math.ceil((100 * 4000 + 100 * 20000 + 1000 * 5000 + 1000 * 8000 + 10000 * 200) / 1000));
    const noModel: NormalizedUsage = { attempts: [attempt(null, "primary", 1000, 0), attempt(null, "fallback", 1000, 0)], servedModel: "x", complete: true };
    expect(costMicro(noModel, cfg).micro).toBe(4000 + 5000); // primary at Opus 5.5, fallback at the dearest target
  });
  it("bounds a request by the primary attempt plus each allowed fallback hop, with the full output cap", () => {
    const cfg = anthropic("claude-opus-5-5");
    const sized = sizeRequest(req, cfg);
    expect(sized.maxOutputTokens).toBe(1500); // the horoscope's cap, not the model default 8000
    const bytes = Buffer.byteLength(JSON.stringify({ system: sized.system, messages: sized.messages, schema: sized.schema }), "utf8");
    const input = bytes + 2048;
    const primary = Math.ceil((input * 4000 + 1500 * 20000) / 1000);
    const hop = Math.ceil((input * 5000 + 1500 * 25000) / 1000);
    expect(requestBoundMicro(sized, cfg, 1500)).toBe(primary + hop);
    expect(requestCostBound(req, cfg)).toBeCloseTo((primary + hop) / 1e6, 9);
    const noFallback = anthropic("claude-opus-5-5", { AI_FALLBACKS: "off" });
    expect(requestBoundMicro(sized, noFallback, 1500)).toBe(primary);
  });
  it("a cost at the largest possible usage never exceeds the bound", () => {
    const cfg = anthropic("claude-sonnet-5-5");
    const sized = sizeRequest({ ...req, purpose: "tarot", system: "长".repeat(4000) }, cfg);
    const cap = sized.maxOutputTokens!;
    expect(cap).toBe(3000);
    const bytes = Buffer.byteLength(JSON.stringify({ system: sized.system, messages: sized.messages, schema: sized.schema }), "utf8");
    const worst: NormalizedUsage = { attempts: [attempt("claude-sonnet-5-5", "primary", bytes + 2048, cap), attempt("claude-sonnet-5", "fallback", bytes + 2048, cap)], servedModel: "claude-sonnet-5", complete: true };
    expect(costMicro(worst, cfg).micro).toBeLessThanOrEqual(requestBoundMicro(sized, cfg, cap));
  });
  it("output caps per purpose come from config (thinking included)", () => {
    const cfg = aiConfig({ AI_MAX_OUTPUT_TAROT: "2500" });
    expect(cfg.maxOutput).toEqual({ tarot: 2500, chat: 1200, talk: 1200, natal: 5000, horoscope: 1500 });
  });
});

describe("usage normalisation", () => {
  it("Anthropic: one attempt per iteration; cache breakdown; missing breakdown priced at 1h", () => {
    const res = { model: "claude-opus-5", usage: { input_tokens: 2000, output_tokens: 510, iterations: [
      { type: "message", model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 }, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 },
      { type: "fallback_message", input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 9 },
    ] } };
    const u = fromAnthropic(res, "claude-opus-5-5");
    expect(u.complete).toBe(true);
    expect(u.servedModel).toBe("claude-opus-5");
    expect(u.attempts).toEqual([
      { model: "claude-opus-5-5", kind: "primary", input: 1000, cacheWrite5m: 5, cacheWrite1h: 0, cacheRead: 7, output: 10 },
      { model: null, kind: "fallback", input: 1000, cacheWrite5m: 0, cacheWrite1h: 9, cacheRead: 0, output: 500 },
    ]);
  });
  it("Anthropic without iterations: a served model other than the requested one can't be attributed (charge the bound)", () => {
    expect(fromAnthropic({ model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5 } }, "claude-opus-5-5").complete).toBe(true);
    expect(fromAnthropic({ model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 5 } }, "claude-opus-5-5").complete).toBe(false);
    expect(fromAnthropic({ model: "claude-opus-5-5" }, "claude-opus-5-5").complete).toBe(false);
  });
  it("OpenAI and proxies: missing usage is incomplete; a proxy is billed as the configured model", () => {
    expect(fromOpenAi({ model: "gpt-5-mini", usage: { prompt_tokens: 3, completion_tokens: 4 } }, "gpt-5-mini")).toMatchObject({ complete: true, attempts: [{ model: "gpt-5-mini", input: 3, output: 4 }] });
    expect(fromOpenAi({ choices: [] }, "gpt-5-mini").complete).toBe(false);
    expect(fromOpenAiCompatible({ model: "some-alias", usage: { prompt_tokens: 3, completion_tokens: 4 } }, "claude-haiku-4-5").attempts[0].model).toBe("claude-haiku-4-5");
  });
});

describe("error billing classes", () => {
  it("classifies provider statuses", () => {
    expect(billingForStatus(429)).toEqual({ billing: "none", rateLimited: true });
    expect(billingForStatus(529)).toEqual({ billing: "none", rateLimited: true });
    expect(billingForStatus(400)).toEqual({ billing: "none", rateLimited: false });
    expect(billingForStatus(500)).toEqual({ billing: "unknown", rateLimited: false });
    expect(billingForStatus(408)).toEqual({ billing: "unknown", rateLimited: false });
    expect(retryAfterSeconds("7")).toBe(7);
    expect(retryAfterSeconds("9999")).toBe(120);
    expect(retryAfterSeconds(null)).toBeUndefined();
  });
  const tmp = () => join(mkdtempSync(join(tmpdir(), "moona-pricing-")), "u.json");
  const limits = { maxCallsPerDay: 100, maxUsdPerDay: 5, maxUsdTotal: 25 };
  const valid = (d: unknown) => validateHoroscope(d);
  it("a rate-limited or rejected request is charged nothing; an unknown failure keeps its hold", async () => {
    const cfg = aiConfig({ AI_API_KEY: "k" });
    const budget = new Budget({ path: tmp(), durable: true }, limits);
    const r429 = vi.fn().mockResolvedValue(new Response("{}", { status: 429, headers: { "retry-after": "3" } }));
    const e = await generateJson(req, valid, { cfg, budget, fetchImpl: r429 }).catch((x) => x);
    expect(e).toBeInstanceOf(AiError);
    expect(e).toMatchObject({ billing: "none", rateLimited: true, retryAfterS: 3, status: 429 });
    await generateJson(req, valid, { cfg, budget, fetchImpl: vi.fn().mockResolvedValue(new Response("{}", { status: 400 })) }).catch(() => null);
    expect(await budget.snapshot()).toMatchObject({ usdTotal: 0, reservedUsdTotal: 0, callsToday: 2 });
    await generateJson(req, valid, { cfg, budget, fetchImpl: vi.fn().mockResolvedValue(new Response("{}", { status: 503 })) }).catch(() => null);
    expect((await budget.snapshot()).reservedUsdTotal).toBeCloseTo(requestCostBound(req, cfg), 9);
  });
  it("a fallback-served Claude reply is charged per attempt", async () => {
    const cfg = anthropic("claude-opus-5-5");
    const budget = new Budget({ path: tmp(), durable: true }, limits);
    const body = { id: "m", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: JSON.stringify({ overall: "o", love: "l", work: "w" }) }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 2000, output_tokens: 510, iterations: [{ type: "message", model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 10 }, { type: "fallback_message", model: "claude-opus-5", input_tokens: 1000, output_tokens: 500 }] } };
    const { meta } = await generateJson(req, valid, { cfg, budget, fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })) });
    expect(meta.model).toBe("claude-opus-5");
    expect(meta.costUsd).toBeCloseTo(0.0217, 6);
    expect((await budget.snapshot()).usdTotal).toBeCloseTo(0.0217, 6);
  });
});

describe("offline fake provider", () => {
  it("is allowed only off deployments (or a rehearsal preview that opts in)", () => {
    const cfg = aiConfig({ AI_PROVIDER: "fake" });
    expect(aiConfigured(cfg, {})).toBe(true);
    expect(aiConfigured(cfg, { VERCEL: "1" })).toBe(false);
    expect(aiConfigured(cfg, { VERCEL: "1", AI_ALLOW_FAKE_ON_DEPLOY: "1" })).toBe(true);
    expect(aiConfigured(aiConfig({}), {})).toBe(false); // a real provider still needs a key
  });
  const cfg = aiConfig({ AI_PROVIDER: "fake" });
  const caps = modelCaps("fake", "simulated");
  const run = async (r: JsonRequest) => JSON.parse((await callFake(cfg, caps, r)).text);
  it("replies pass the real validators for every purpose, in both languages, and are marked [MOCK]", async () => {
    for (const locale of ["en", "zh"] as const) {
      const tarot = parseTarotRequest({ locale, spread: "triad", topic: "work", question: "Should I stay?", cards: [{ id: "swords-03", reversed: true }, { id: "major-13", reversed: false }, { id: "pentacles-10", reversed: false }] })!;
      const tp = tarotPrompt(tarot);
      const tv = validateTarot(await run({ purpose: "tarot", system: tp.system, messages: [{ role: "user", content: tp.user }], schema: TAROT_SCHEMA, schemaName: "t" }), tarot);
      expect(tv?.synthesis).toMatch(/^\[MOCK\]/);
      const chat = parseChatRequest({ locale, reading: { locale, spread: "single", topic: "general", cards: [{ id: "major-13", reversed: false }] }, messages: [{ role: "user", content: "What does this mean for my job?" }] })!;
      const cp = chatPrompt(chat);
      expect(validateChat(await run({ purpose: "chat", system: cp.system, messages: cp.messages, schema: CHAT_SCHEMA, schemaName: "c" }), chat)).not.toBeNull();
      const talk = parseTalkRequest({ locale, messages: [{ role: "user", content: "I keep doubting myself." }] })!;
      const ctx = talkContext(talk);
      const kp = talkPrompt(talk, ctx.items);
      expect(validateTalk(await run({ purpose: "talk", system: kp.system, messages: kp.messages, schema: TALK_SCHEMA, schemaName: "k" }), talk, ctx.items, ctx.claims)).not.toBeNull();
      const h = parseHoroscopeRequest(horoscopeBody(dayHoroscope({ sunSign: "leo" }, "2026-10-28", "America/New_York"), "2026-10-28", "America/New_York", locale))!;
      const hp = horoscopePrompt(h);
      expect(validateHoroscope(await run({ purpose: "horoscope", system: hp.system, messages: [{ role: "user", content: hp.user }], schema: HOROSCOPE_SCHEMA, schemaName: "h" }))).not.toBeNull();
    }
  });
  it("simulates failures with the right billing class, and its model is 'simulated'", async () => {
    const r = sizeRequest(req, cfg);
    await expect(callFake(cfg, caps, r, { fail: "timeout" })).rejects.toMatchObject({ code: "timeout", billing: "unknown" });
    await expect(callFake(cfg, caps, r, { fail: "rate_limited" })).rejects.toMatchObject({ billing: "none", rateLimited: true });
    await expect(callFake(cfg, caps, r, { fail: "refusal" })).rejects.toMatchObject({ code: "refused", billing: "known" });
    expect((await callProvider(r, cfg, { fake: {} })).model).toBe("simulated");
    const fb = await callFake(cfg, caps, r, { fallback: true, usage: "max" });
    expect(fb.usage.attempts.map((a) => a.kind)).toEqual(["primary", "fallback"]);
    expect(costMicro(fb.usage, cfg).micro).toBeGreaterThan(0); // priced as FAKE_AI_PRICE_AS (Sonnet 5.5)
  });
  it("draws scripted failures deterministically from the environment", () => {
    const a = fakeScriptFromEnv({ FAKE_AI_FAILURES: "timeout:0.5,rate_limited:0.25", FAKE_AI_LATENCY_MS: "5" }, 42);
    const b = fakeScriptFromEnv({ FAKE_AI_FAILURES: "timeout:0.5,rate_limited:0.25", FAKE_AI_LATENCY_MS: "5" }, 42);
    const seqA = Array.from({ length: 50 }, () => a().fail ?? "ok");
    expect(Array.from({ length: 50 }, () => b().fail ?? "ok")).toEqual(seqA);
    expect(new Set(seqA)).toEqual(new Set(["timeout", "rate_limited", "ok"]));
  });
});
