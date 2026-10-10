// The AI routes on the shared SQL ledger (spec §11 routes.ai): replay by request id, the status codes
// of §8.2, crisis never reserving, shared Sun-sign horoscopes, configured output caps reaching the
// provider, and a status route that never shows costs or keys.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as horoscopePOST } from "@/app/api/ai/horoscope/route";
import { POST as tarotPOST } from "@/app/api/ai/tarot/route";
import { POST as talkPOST } from "@/app/api/ai/talk/route";
import { GET as statusGET } from "@/app/api/ai/status/route";
import { setLedgerForTests } from "@/lib/ledger/factory";
import { VISITOR_COOKIE } from "@/lib/identity/visitor";
import { serverKeys } from "@/lib/identity/keys";
import { OPS_COOKIE, opsCookieValue } from "@/lib/identity/ops";
import { dayHoroscope, horoscopeBody } from "@/lib/astro/horoscope-day";
import type { BirthData } from "@/lib/astro/birth";
import { M, LEDGER_TIMEOUT, expectAudit, makeTestLedger, row, testPlan, type TestLedger } from "./helpers/ledger";

const DATE = "2026-10-12", TZ = "America/New_York";
const sunBody = (sign: "leo" | "aries" = "leo") => JSON.parse(JSON.stringify(horoscopeBody(dayHoroscope({ sunSign: sign }, DATE, TZ), DATE, TZ, "en")));
const boston = { name: "Boston", country: "US", lat: 42.3601, lon: -71.0589, tz: "America/New_York" };
const birth: BirthData = { date: "1999-08-14", time: "07:30", place: boston } as BirthData;
const natalBody = () => JSON.parse(JSON.stringify(horoscopeBody(dayHoroscope({ birth, houseSystem: "placidus" }, DATE, TZ), DATE, TZ, "en")));
const triad = { locale: "en", spread: "triad", topic: "work", question: "Should I stay at my job?", cards: [{ id: "swords-03", reversed: true }, { id: "major-13", reversed: false }, { id: "pentacles-10", reversed: false }] };

const good = { overall: "A steady day.", love: "Say what you feel.", work: "Finish one thing." };
const reply = (content: unknown) => new Response(JSON.stringify({ model: "claude-haiku-4-5", choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 200 } }), { status: 200, headers: { "Content-Type": "application/json" } });
const tarotReply = { cards: [0, 1, 2].map((position) => ({ position, insight: `Card ${position} speaks to the job question.` })), synthesis: "Together they describe change at work.", action: "Write down what you would keep.", reflection: "What matters most here?" };

let t: TestLedger;
let fetchSpy: ReturnType<typeof vi.fn>;
const jar = new Map<string, string>(); // one cookie per simulated browser

function post(url: string, body: unknown, browser = "a") {
  const cookie = jar.get(browser);
  return new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": "203.0.113.7", ...(cookie ? { cookie } : {}) } });
}
async function call(route: (r: NextRequest) => Promise<Response>, url: string, body: unknown, browser = "a") {
  const res = await route(post(url, body, browser));
  const set = res.headers.get("set-cookie");
  if (set?.startsWith(`${VISITOR_COOKIE}=`)) jar.set(browser, set.split(";")[0]);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  vi.stubEnv("AI_API_KEY", "test-key-value");
  vi.stubEnv("AI_PROVIDER", "openai-compatible");
  vi.stubEnv("AI_MODEL", "claude-haiku-4-5");
  jar.clear();
  t = await makeTestLedger();
  setLedgerForTests(t.ledger);
  fetchSpy = vi.fn(async () => reply(good));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  setLedgerForTests(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("AI routes on the ledger", LEDGER_TIMEOUT, () => {
  it("replays the same request id for free and mints one visitor", async () => {
    const first = await call(horoscopePOST, "/api/ai/horoscope", { ...sunBody(), requestId: "abcdefghijklmnop0001" });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ ...good, meta: { provider: "openai-compatible", source: "live" } });
    expect(jar.get("a")).toMatch(new RegExp(`^${VISITOR_COOKIE}=v1\\.`));
    const again = await call(horoscopePOST, "/api/ai/horoscope", { ...sunBody(), requestId: "abcdefghijklmnop0001" });
    expect(again).toMatchObject({ status: 200, json: { ...good, replayed: true } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first.json)).not.toMatch(/cost|micro|test-key-value/);
    await expectAudit(t.ledger);
  });

  it("answers 422 for a reused id with other input, and 409 when a failed id is retried", async () => {
    await call(horoscopePOST, "/api/ai/horoscope", { ...sunBody(), requestId: "abcdefghijklmnop0002" });
    const reused = await call(horoscopePOST, "/api/ai/horoscope", { ...sunBody("aries"), requestId: "abcdefghijklmnop0002" });
    expect(reused).toEqual({ status: 422, json: { code: "key_reused" } });
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 400 }));
    const failed = await call(horoscopePOST, "/api/ai/horoscope", { ...natalBody(), requestId: "abcdefghijklmnop0003" });
    expect(failed.status).toBe(502);
    expect(await call(horoscopePOST, "/api/ai/horoscope", { ...natalBody(), requestId: "abcdefghijklmnop0003" })).toEqual({ status: 409, json: { code: "retry_new_key" } });
    await expectAudit(t.ledger);
  });

  it("answers 202 while the same request is still running", async () => {
    await call(horoscopePOST, "/api/ai/horoscope", sunBody("aries")); // mint the visitor first
    let release!: (r: Response) => void;
    fetchSpy.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    const running = horoscopePOST(post("/api/ai/horoscope", { ...sunBody(), requestId: "abcdefghijklmnop0004" }));
    await new Promise((r) => setTimeout(r, 30));
    const waiting = await call(horoscopePOST, "/api/ai/horoscope", { ...sunBody(), requestId: "abcdefghijklmnop0004" });
    expect(waiting).toEqual({ status: 202, json: { code: "in_progress", retryAfterMs: 2000 } });
    release(reply(good));
    expect((await running).status).toBe(200);
    await expectAudit(t.ledger);
  });

  it("answers 429 quota once a visitor's free readings are used, per visitor", async () => {
    t = await makeTestLedger({ plan: testPlan({ windows: [{ id: "win:t", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z", capMicro: 5 * M, quota: { horoscope: [1, 3] } }] }) });
    setLedgerForTests(t.ledger);
    expect((await call(horoscopePOST, "/api/ai/horoscope", natalBody(), "a")).status).toBe(200);
    expect(await call(horoscopePOST, "/api/ai/horoscope", sunBody("aries"), "a")).toEqual({ status: 429, json: { code: "quota", credits: null } });
    // another browser behind the same address has its own allowance
    expect((await call(horoscopePOST, "/api/ai/horoscope", sunBody("aries"), "b")).status).toBe(200);
    await expectAudit(t.ledger);
  });

  it("never reserves for a crisis message", async () => {
    const res = await call(talkPOST, "/api/ai/talk", { locale: "en", messages: [{ role: "user", content: "I want to kill myself" }] });
    expect(res).toEqual({ status: 200, json: { code: "crisis" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await row<{ n: number }>(t.exec, "select count(*)::int as n from moona.requests")).n).toBe(0);
    expect(jar.has("a")).toBe(false); // no visitor minted either
  });

  it("shares a Sun-sign horoscope between visitors, never one with Moon or Rising", async () => {
    await call(horoscopePOST, "/api/ai/horoscope", sunBody(), "a");
    const b = await call(horoscopePOST, "/api/ai/horoscope", sunBody(), "b");
    expect(b.json.replayed).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await call(horoscopePOST, "/api/ai/horoscope", natalBody(), "a");
    const natalB = await call(horoscopePOST, "/api/ai/horoscope", natalBody(), "b");
    expect(natalB.json.replayed).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await expectAudit(t.ledger);
  });

  it("sends the configured tarot output cap to the provider", async () => {
    fetchSpy.mockImplementation(async () => reply(tarotReply));
    const res = await call(tarotPOST, "/api/ai/tarot", triad);
    expect(res.status).toBe(200);
    const sent = JSON.parse(String((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent.max_tokens ?? sent.max_completion_tokens).toBe(3000);
  });

  it("maps budget use to status levels; spending details go to operators only", async () => {
    const plan = testPlan({ aiMicro: 10 * M, windows: [{ id: "win:t", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z", capMicro: 10 * M }] });
    const levels: string[] = [];
    for (const [i, used] of [0.5, 0.8, 0.95, 1].entries()) {
      t = await makeTestLedger({ plan });
      setLedgerForTests(t.ledger);
      await t.ledger.recordSpend({ entryId: `s${i}`, pools: ["ai", "win:t"], amountMicro: Math.round(used * 10 * M), kind: "manual_spend", note: "" });
      const s = await (await statusGET(new NextRequest("http://localhost/api/ai/status"))).json();
      levels.push(s.level);
      expect(JSON.stringify(s)).not.toContain("test-key-value");
    }
    expect(levels).toEqual(["notice", "warn", "critical", "exhausted"]);
    vi.stubEnv("AI_ACCESS_CODE", "venue");
    expect(await (await statusGET(new NextRequest("http://localhost/api/ai/status"))).json()).toEqual({ available: false, reason: "locked" });
    const open = await (await statusGET(new NextRequest("http://localhost/api/ai/status", { headers: { cookie: "moona-ai-access=venue" } }))).json();
    expect(open).toMatchObject({ available: false, reason: "budget", level: "exhausted" });
    expect(open).not.toHaveProperty("budget");
    vi.stubEnv("OPS_TOKEN", "operator-token-for-tests-0123456789");
    const ops = await (await statusGET(new NextRequest("http://localhost/api/ai/status", { headers: { cookie: `${OPS_COOKIE}=${opsCookieValue(serverKeys()!)}` } }))).json();
    expect(ops).toMatchObject({ level: "exhausted", budget: { kind: "sql" } });
  });
});
