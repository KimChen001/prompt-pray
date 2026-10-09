import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AiError, chatJson, extractJson, type AiConfig } from "@/lib/ai/provider";
import { horoscopePrompt, parseHoroscopeRequest, validateHoroscope } from "@/lib/ai/horoscope-prompt";
import { resetAiLimits } from "@/lib/ai/guard";
import { POST } from "@/app/api/ai/horoscope/route";

const cfg: AiConfig = { baseUrl: "https://example.test/v1", apiKey: "test-key", model: "claude-haiku-4-5", accessCode: "" };
const goodBody = { locale: "en", date: "2026-10-28", tone: "tension", subject: { sun: "Leo", moon: "Virgo" }, facts: ["Mercury is retrograde.", "The Moon is in your 10th house."] };
const reply = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers: { "Content-Type": "application/json" } });
const req = (body: unknown, cookie?: string) =>
  new NextRequest("http://localhost/api/ai/horoscope", { method: "POST", body: JSON.stringify(body), headers: cookie ? { cookie } : {} });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetAiLimits();
});

describe("extractJson", () => {
  it("handles fences and surrounding prose", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a": "b"} Hope this helps')).toEqual({ a: "b" });
    expect(() => extractJson("no json here")).toThrow(AiError);
  });
});

describe("horoscope request/response validation", () => {
  it("accepts a well-formed request and rejects junk", () => {
    expect(parseHoroscopeRequest(goodBody)).toMatchObject({ locale: "en", tone: "tension", facts: goodBody.facts });
    expect(parseHoroscopeRequest({ ...goodBody, date: "10/28/2026" })).toBeNull();
    expect(parseHoroscopeRequest({ ...goodBody, facts: [] })).toBeNull();
    expect(parseHoroscopeRequest({ ...goodBody, facts: ["x".repeat(400)] })).toBeNull();
    expect(parseHoroscopeRequest(null)).toBeNull();
  });
  it("caps the number of facts", () => {
    const r = parseHoroscopeRequest({ ...goodBody, facts: Array.from({ length: 20 }, (_, i) => `fact ${i}`) });
    expect(r?.facts).toHaveLength(8);
  });
  it("puts only the given facts in the prompt, in the right language", () => {
    const p = horoscopePrompt(parseHoroscopeRequest({ ...goodBody, locale: "zh" })!);
    expect(p.system).toMatch(/Simplified Chinese/);
    expect(p.system).toMatch(/ONLY the sky facts/);
    expect(p.user).toContain("- Mercury is retrograde.");
    expect(p.user).toContain("Sun Leo, Moon Virgo");
  });
  it("rejects missing, oversized or unsafe output", () => {
    expect(validateHoroscope({ overall: "a", love: "b", work: "c" })).toEqual({ overall: "a", love: "b", work: "c" });
    expect(validateHoroscope({ overall: "a", love: "b" })).toBeNull();
    expect(validateHoroscope({ overall: "a".repeat(1000), love: "b", work: "c" })).toBeNull();
    expect(validateHoroscope({ overall: "You may want to die today", love: "b", work: "c" })).toBeNull();
  });
});

describe("chatJson", () => {
  it("refuses to call without a key", async () => {
    await expect(chatJson({ system: "s", user: "u" }, { ...cfg, apiKey: "" })).rejects.toMatchObject({ code: "unconfigured" });
  });
  it("sends an OpenAI-style request and parses the reply", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply('{"overall":"o","love":"l","work":"w"}'));
    vi.stubGlobal("fetch", fetchMock);
    const out = await chatJson({ system: "s", user: "u" }, cfg);
    expect(out.data).toEqual({ overall: "o", love: "l", work: "w" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body)).toMatchObject({ model: "claude-haiku-4-5", messages: [{ role: "system" }, { role: "user" }] });
  });
  it("maps upstream errors and timeouts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply("x", 500)));
    await expect(chatJson({ system: "s", user: "u" }, cfg)).rejects.toMatchObject({ code: "upstream" });
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))));
    await expect(chatJson({ system: "s", user: "u", timeoutMs: 20 }, cfg)).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("POST /api/ai/horoscope", () => {
  beforeEach(() => vi.stubEnv("AI_BASE_URL", "https://example.test/v1"));

  it("returns 503 when AI is not configured (template stays on screen)", async () => {
    vi.stubEnv("AI_API_KEY", "");
    const res = await POST(req(goodBody));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: "unconfigured" });
  });
  it("is locked behind the access code when one is set", async () => {
    vi.stubEnv("AI_API_KEY", "k");
    vi.stubEnv("AI_ACCESS_CODE", "demo123");
    expect((await POST(req(goodBody))).status).toBe(503);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply('{"overall":"o","love":"l","work":"w"}')));
    expect((await POST(req(goodBody, "moona-ai-access=demo123"))).status).toBe(200);
  });
  it("returns validated text, or 502 when the model output is unusable", async () => {
    vi.stubEnv("AI_API_KEY", "k");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply('{"overall":"o","love":"l","work":"w"}')));
    const ok = await POST(req(goodBody));
    expect(await ok.json()).toMatchObject({ overall: "o", love: "l", work: "w", source: "live" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply("I cannot do that")));
    expect((await POST(req(goodBody))).status).toBe(502);
  });
  it("rejects malformed requests", async () => {
    vi.stubEnv("AI_API_KEY", "k");
    expect((await POST(req({ nope: true }))).status).toBe(400);
  });
});
