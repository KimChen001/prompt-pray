// Identity (spec §11 identity): a signed pseudonymous visitor cookie, minted through the ledger's
// mint caps the first time a browser reaches it; limits are per visitor, never per IP; and nothing
// spends without a shared ledger or without SESSION_SECRET on a deployment.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { serverKeys } from "@/lib/identity/keys";
import { ensureVisitor, netBucket, readVisitor, verifyVisitorCookie, visitorCookieValue, VISITOR_COOKIE } from "@/lib/identity/visitor";
import { aiUnavailable, burstLimit, checkAiAccess, resetAiLimits, AI_LIMITS } from "@/lib/ai/guard";
import { ledgerConfigured, ledgerKind } from "@/lib/ledger/factory";
import { POST as talkPOST } from "@/app/api/ai/talk/route";
import { GET as statusGET } from "@/app/api/ai/status/route";
import { LEDGER_TIMEOUT, M, makeTestLedger, testPlan } from "./helpers/ledger";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetAiLimits();
});

const SECRET = "x".repeat(40);
const keys = serverKeys({ SESSION_SECRET: SECRET })!;
const UUID = "4b0c8a8e-2f7a-4d55-9a37-3f1d0c2b9e61";
const req = (o: { cookie?: string; ip?: string; https?: boolean } = {}) =>
  new NextRequest(`${o.https ? "https" : "http"}://localhost/api/ai/talk`, { method: "POST", headers: { ...(o.cookie ? { cookie: o.cookie } : {}), "x-forwarded-for": o.ip ?? "203.0.113.7" } });

describe("server keys", () => {
  it("derives separate keys from SESSION_SECRET; none on a deployment without one", () => {
    expect(keys.cookie.equals(keys.input)).toBe(false);
    expect(serverKeys({ SESSION_SECRET: SECRET })).toBe(keys);
    expect(serverKeys({ SESSION_SECRET: "y".repeat(40) })!.cookie.equals(keys.cookie)).toBe(false);
    expect(serverKeys({ VERCEL: "1" })).toBeNull();
    expect(serverKeys({ MOONA_DEPLOYED: "1", SESSION_SECRET: "short" })).toBeNull();
    expect(serverKeys({ VERCEL: "1", SESSION_SECRET: SECRET })).toBe(keys);
    // locally a fixed development key, so cookies survive a restart
    expect(serverKeys({})!.cookie.equals(serverKeys({ SESSION_SECRET: "" })!.cookie)).toBe(true);
  });
});

describe("visitor cookie", () => {
  it("accepts its own signature and treats forged, garbled or foreign cookies as absent", () => {
    const v = visitorCookieValue(keys, UUID);
    expect(verifyVisitorCookie(v, keys)).toBe(UUID);
    expect(readVisitor(req({ cookie: `${VISITOR_COOKIE}=${v}` }), keys)).toBe(UUID);
    expect(verifyVisitorCookie(v, serverKeys({ SESSION_SECRET: "z".repeat(40) })!)).toBeNull();
    expect(verifyVisitorCookie(v.replace(UUID, "4b0c8a8e-2f7a-4d55-9a37-3f1d0c2b9e62"), keys)).toBeNull();
    expect(verifyVisitorCookie(`${v.slice(0, -1)}${v.endsWith("A") ? "B" : "A"}`, keys)).toBeNull();
    expect(verifyVisitorCookie("v1.not-a-uuid.sig", keys)).toBeNull();
    expect(verifyVisitorCookie(undefined, keys)).toBeNull();
    // the Phase 0 cookie format is not accepted
    expect(readVisitor(req({ cookie: "moona-v=abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuv" }), keys)).toBeNull();
  });

  it("buckets networks without keeping the address", () => {
    const at = new Date("2026-10-28T15:00:00Z");
    const b = (ip: string) => netBucket(req({ ip }), keys, at);
    expect(b("203.0.113.7")).toBe(b("203.0.113.200"));
    expect(b("203.0.113.7")).not.toBe(b("203.0.114.7"));
    expect(b("::ffff:203.0.113.9")).toBe(b("203.0.113.7"));
    expect(b("2001:db8:abcd:1::5")).toBe(b("2001:db8:abcd:ffff::1"));
    expect(b("2001:db8:abcd:1::5")).not.toBe(b("2001:db8:abce::1"));
    expect(b("203.0.113.7")).not.toContain("203");
    expect(netBucket(req({ ip: "203.0.113.7" }), keys, new Date("2026-10-29T15:00:00Z"))).not.toBe(b("203.0.113.7"));
  });

  it("mints once a request reaches the ledger, within the mint caps", async () => {
    const { ledger } = await makeTestLedger({ plan: testPlan({ mintNetLimit: 2, windows: [{ id: "win:t", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z", capMicro: 5 * M, mintCap: 3 }] }) });
    const first = await ensureVisitor(req({ https: true }), ledger, keys);
    if ("denied" in first) throw new Error("denied");
    expect(first.set).toMatchObject({ name: VISITOR_COOKIE, options: { httpOnly: true, sameSite: "lax", secure: true, path: "/" } });
    expect(verifyVisitorCookie(first.set!.value, keys)).toBe(first.id);
    const plain = await ensureVisitor(req(), ledger, keys);
    expect("set" in plain && plain.set!.options.secure).toBe(false);
    // the same network can't mint more than its limit; a cookie already held needs no mint
    expect(await ensureVisitor(req({ ip: "203.0.113.50" }), ledger, keys)).toEqual({ denied: "visitor_cap" });
    expect(await ensureVisitor(req({ cookie: `${VISITOR_COOKIE}=${first.set!.value}` }), ledger, keys)).toEqual({ id: first.id });
    // the event's window cap counts every network
    await ensureVisitor(req({ ip: "198.51.100.1" }), ledger, keys);
    expect(await ensureVisitor(req({ ip: "192.0.2.1" }), ledger, keys)).toEqual({ denied: "visitor_cap" });
  }, LEDGER_TIMEOUT.timeout);
});

describe("limits are per visitor, not per IP", () => {
  it("visitors behind one address each get their own burst allowance", () => {
    for (let i = 0; i < AI_LIMITS.perVisitor; i++) expect(burstLimit("v:a")).toBe(false);
    expect(burstLimit("v:a")).toBe(true);
    expect(burstLimit("v:b")).toBe(false);
  });
});

describe("no shared ledger, no spending", () => {
  it("picks the ledger from the environment and never a per-instance one on serverless", () => {
    expect(ledgerKind({})).toBe("file");
    expect(ledgerKind({ VERCEL: "1" })).toBeNull();
    expect(ledgerKind({ VERCEL: "1", MOONA_LEDGER: "pglite" })).toBeNull();
    expect(ledgerKind({ VERCEL: "1", DATABASE_URL: "postgres://x" })).toBe("postgres");
    expect(ledgerKind({ MOONA_LEDGER: "postgres" })).toBeNull();
    expect(ledgerKind({ MOONA_LEDGER: "memory" })).toBe("memory");
    expect(ledgerConfigured({ NETLIFY: "true" })).toBe(false);
  });

  it("on Vercel without a database AI is off (503 'ledger') and the provider is never called", async () => {
    vi.stubEnv("AI_API_KEY", "k");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("SESSION_SECRET", SECRET);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(aiUnavailable()).toBe("ledger");
    expect(checkAiAccess(req())).toBe("ledger");
    const res = await talkPOST(new NextRequest("http://localhost/api/ai/talk", { method: "POST", body: JSON.stringify({ locale: "en", messages: [{ role: "user", content: "hello" }] }) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: "ledger" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await (await statusGET(new NextRequest("http://localhost/api/ai/status"))).json()).toEqual({ available: false, reason: "ledger" });
  });

  it("a deployment with a database but no SESSION_SECRET is 'misconfigured'", () => {
    expect(aiUnavailable({ AI_API_KEY: "k", VERCEL: "1", DATABASE_URL: "postgres://x" })).toBe("misconfigured");
    expect(aiUnavailable({ AI_API_KEY: "k", VERCEL: "1", DATABASE_URL: "postgres://x", SESSION_SECRET: SECRET })).toBeNull();
  });
});
