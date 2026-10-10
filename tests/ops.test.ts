// Operator devices and housekeeping: OPS_TOKEN signs a device in for 12 hours (failed attempts are
// throttled), operators skip free quotas but never money caps, and reconcile pauses spending when
// any counter disagrees with its rows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as sessionPOST } from "@/app/api/ops/session/route";
import { GET as reconcileGET, POST as reconcilePOST } from "@/app/api/ops/reconcile/route";
import { POST as horoscopePOST } from "@/app/api/ai/horoscope/route";
import { setLedgerForTests } from "@/lib/ledger/factory";
import { serverKeys } from "@/lib/identity/keys";
import { OPS_COOKIE, opsCookieValue, verifyOpsCookie } from "@/lib/identity/ops";
import { dayHoroscope, horoscopeBody } from "@/lib/astro/horoscope-day";
import { LEDGER_TIMEOUT, M, makeTestLedger, testPlan, type TestLedger } from "./helpers/ledger";

const TOKEN = "operator-token-for-tests-0123456789";
const body = (sign: "leo" | "aries" | "virgo") => JSON.parse(JSON.stringify(horoscopeBody(dayHoroscope({ sunSign: sign }, "2026-10-12", "America/New_York"), "2026-10-12", "America/New_York", "en")));
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ overall: "A steady day.", love: "Say it.", work: "Finish one." }) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 100 } }), { status: 200 });
let t: TestLedger;

beforeEach(async () => {
  vi.stubEnv("OPS_TOKEN", TOKEN);
  vi.stubEnv("AI_API_KEY", "test-key-value");
  vi.stubEnv("MOONA_LEDGER", "memory");
  vi.stubGlobal("fetch", vi.fn(async () => reply()));
  t = await makeTestLedger({ plan: testPlan({ windows: [{ id: "win:t", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z", capMicro: 5 * M, quota: { horoscope: [1, 3] } }] }) });
  setLedgerForTests(t.ledger);
});
afterEach(() => {
  setLedgerForTests(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const signIn = (token: unknown) => sessionPOST(new NextRequest("http://localhost/api/ops/session", { method: "POST", body: JSON.stringify({ token }) }));

describe("operator devices", LEDGER_TIMEOUT, () => {
  it("signs in with the token for 12 hours, and throttles failures", async () => {
    const ok = await signIn(TOKEN);
    expect(ok.status).toBe(200);
    const cookie = ok.cookies.get(OPS_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "strict", maxAge: 12 * 3600 });
    const keys = serverKeys()!;
    expect(verifyOpsCookie(cookie.value, keys)).toBe(true);
    expect(verifyOpsCookie(cookie.value, keys, Date.now() + 13 * 3600_000)).toBe(false);
    expect(verifyOpsCookie(opsCookieValue(serverKeys({ SESSION_SECRET: "q".repeat(40) })!), keys)).toBe(false);
    for (let i = 0; i < 10; i++) expect((await signIn(`wrong-${i}`)).status).toBe(401);
    expect((await signIn(TOKEN)).status).toBe(429);
  });

  it("does nothing without a long enough OPS_TOKEN", async () => {
    vi.stubEnv("OPS_TOKEN", "short");
    expect((await signIn("short")).status).toBe(404);
  });

  it("lets operators past free quotas but not past the money caps", async () => {
    const ops = `${OPS_COOKIE}=${opsCookieValue(serverKeys()!)}`;
    const send = (sign: "leo" | "aries" | "virgo", cookie?: string) => horoscopePOST(new NextRequest("http://localhost/api/ai/horoscope", { method: "POST", body: JSON.stringify(body(sign)), headers: cookie ? { cookie } : {} }));
    const first = await send("leo");
    const visitorCookie = first.headers.get("set-cookie")!.split(";")[0];
    expect((await send("aries", visitorCookie)).status).toBe(429); // a visitor's quota is 1
    expect((await send("aries", `${visitorCookie}; ${ops}`)).status).toBe(200);
    expect((await send("virgo", `${visitorCookie}; ${ops}`)).status).toBe(200);
  });
});

describe("reconcile", LEDGER_TIMEOUT, () => {
  it("answers the scheduler only with CRON_SECRET, and operators by cookie", async () => {
    const get = (auth?: string) => reconcileGET(new NextRequest("http://localhost/api/ops/reconcile", { headers: auth ? { authorization: auth } : {} }));
    expect((await get("Bearer x")).status).toBe(404);
    vi.stubEnv("CRON_SECRET", "cron-secret-for-tests");
    expect((await get("Bearer wrong")).status).toBe(401);
    const ok = await get("Bearer cron-secret-for-tests");
    expect(await ok.json()).toEqual({ reaped: 0, ordersSynced: 0, purged: 0, auditViolations: 0, level: "ok" });
    expect((await reconcilePOST(new NextRequest("http://localhost/api/ops/reconcile", { method: "POST" }))).status).toBe(401);
    const asOps = await reconcilePOST(new NextRequest("http://localhost/api/ops/reconcile", { method: "POST", headers: { cookie: `${OPS_COOKIE}=${opsCookieValue(serverKeys()!)}` } }));
    expect(asOps.status).toBe(200);
  });

  it("pauses spending when the audit finds a counter that disagrees with its rows", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-for-tests");
    await t.exec.exec("update moona.pools set spent_micro = spent_micro + 1 where id = 'ai'");
    const res = await reconcileGET(new NextRequest("http://localhost/api/ops/reconcile", { headers: { authorization: "Bearer cron-secret-for-tests" } }));
    expect((await res.json()).auditViolations).toBeGreaterThan(0);
    const snap = await t.ledger.snapshot();
    expect(snap.kind === "sql" && [snap.gate.breaker, snap.gate.breakerReason?.startsWith("audit")]).toEqual(["tripped", true]);
  });
});
