// Budget plan §5 and the design review's "Phase 0": AI limits are per visitor (a signed cookie), not
// per IP, so a room on one school Wi-Fi isn't blocked as one person; and a serverless deployment never
// spends without a shared ledger.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mintVisitor, verifyVisitor, visitorSecret, VISITOR_COOKIE } from "@/lib/visitor";
import { AI_LIMITS, aiUnavailable, checkAiAccess, resetAiLimits } from "@/lib/ai/guard";
import { sharedLedgerAvailable, usageFilePath } from "@/lib/ai/budget";
import { proxy } from "@/proxy";
import { GET as statusGET } from "@/app/api/ai/status/route";

afterEach(() => {
  vi.unstubAllEnvs();
  resetAiLimits();
});

const SECRET = "x".repeat(40);
const req = (opts: { cookie?: string; ip?: string } = {}) =>
  new NextRequest("http://localhost/api/ai/talk", { method: "POST", headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), "x-forwarded-for": opts.ip ?? "203.0.113.7" } });

describe("signed visitor ids", () => {
  it("verifies its own ids and rejects tampered, foreign or malformed ones", () => {
    const v = mintVisitor(SECRET);
    const id = verifyVisitor(v, SECRET);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(verifyVisitor(v, "y".repeat(40))).toBeNull();
    expect(verifyVisitor(`${v.slice(0, -1)}${v.endsWith("A") ? "B" : "A"}`, SECRET)).toBeNull();
    expect(verifyVisitor(`${"a".repeat(22)}.${v.split(".")[1]}`, SECRET)).toBeNull();
    expect(verifyVisitor("not-a-cookie", SECRET)).toBeNull();
    expect(verifyVisitor(undefined, SECRET)).toBeNull();
    expect(mintVisitor(SECRET)).not.toBe(v);
  });
  it("uses SESSION_SECRET; locally a per-process key; on Vercel without one, none", () => {
    expect(visitorSecret({ SESSION_SECRET: SECRET })).toBe(SECRET);
    expect(visitorSecret({ SESSION_SECRET: "short" })).not.toBe("short");
    expect(visitorSecret({})).toBe(visitorSecret({}));
    expect(visitorSecret({ VERCEL: "1" })).toBeNull();
    expect(visitorSecret({ VERCEL: "1", SESSION_SECRET: SECRET })).toBe(SECRET);
  });
  it("the proxy sets a visitor cookie on page loads that lack a valid one, and keeps a valid one", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const fresh = proxy(new NextRequest("http://localhost/today"));
    const set = fresh.cookies.get(VISITOR_COOKIE);
    expect(set?.value && verifyVisitor(set.value, SECRET)).toBeTruthy();
    expect(set).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    const kept = proxy(new NextRequest("http://localhost/today", { headers: { cookie: `${VISITOR_COOKIE}=${set!.value}` } }));
    expect(kept.cookies.get(VISITOR_COOKIE)).toBeUndefined();
    const forged = proxy(new NextRequest("http://localhost/today", { headers: { cookie: `${VISITOR_COOKIE}=forged.value` } }));
    expect(forged.cookies.get(VISITOR_COOKIE)?.value).not.toBe("forged.value");
  });
});

describe("AI burst limits are per visitor, not per IP", () => {
  it("many visitors on one school IP each get their own allowance", () => {
    vi.stubEnv("AI_API_KEY", "k");
    vi.stubEnv("SESSION_SECRET", SECRET);
    const a = `${VISITOR_COOKIE}=${mintVisitor(SECRET)}`;
    const b = `${VISITOR_COOKIE}=${mintVisitor(SECRET)}`;
    for (let i = 0; i < AI_LIMITS.perVisitor; i++) expect(checkAiAccess(req({ cookie: a }))).toBeNull();
    expect(checkAiAccess(req({ cookie: a }))).toBe("rate_limited");
    expect(checkAiAccess(req({ cookie: b }))).toBeNull(); // same IP, another person
    // 30 more people behind the same NAT are unaffected.
    for (let p = 0; p < 30; p++) expect(checkAiAccess(req({ cookie: `${VISITOR_COOKIE}=${mintVisitor(SECRET)}` }))).toBeNull();
  });
  it("requests without a valid visitor cookie share a per-IP bucket; every IP has a ceiling", () => {
    vi.stubEnv("AI_API_KEY", "k");
    vi.stubEnv("SESSION_SECRET", SECRET);
    for (let i = 0; i < AI_LIMITS.perAnonymousIp; i++) expect(checkAiAccess(req({ ip: "198.51.100.1" }))).toBeNull();
    expect(checkAiAccess(req({ ip: "198.51.100.1" }))).toBe("rate_limited");
    expect(checkAiAccess(req({ ip: "198.51.100.1", cookie: `${VISITOR_COOKIE}=forged.value` }))).toBe("rate_limited"); // a forged cookie is anonymous
    expect(checkAiAccess(req({ ip: "198.51.100.2" }))).toBeNull();
    // The ceiling across all visitors of one IP stops a cookie-minting script.
    for (let i = 0; i < AI_LIMITS.perIpCeiling; i++) expect(checkAiAccess(req({ ip: "192.0.2.9", cookie: `${VISITOR_COOKIE}=${mintVisitor(SECRET)}` }))).toBeNull();
    expect(checkAiAccess(req({ ip: "192.0.2.9", cookie: `${VISITOR_COOKIE}=${mintVisitor(SECRET)}` }))).toBe("rate_limited");
  });
});

describe("no shared ledger, no paid AI", () => {
  it("a serverless deployment's file ledger is never treated as a shared cap", () => {
    expect(usageFilePath({ VERCEL: "1" }).durable).toBe(false);
    expect(usageFilePath({ VERCEL: "1", AI_USAGE_FILE: "/tmp/x.json" }).durable).toBe(false);
    expect(sharedLedgerAvailable({ VERCEL: "1" })).toBe(false);
    expect(sharedLedgerAvailable({})).toBe(true);
    expect(sharedLedgerAvailable({ AI_USAGE_FILE: "/srv/ledger.json" })).toBe(true);
  });
  it("on Vercel AI is off (503 'ledger'), and without SESSION_SECRET it would be 'misconfigured'", async () => {
    vi.stubEnv("AI_API_KEY", "k");
    vi.stubEnv("VERCEL", "1");
    expect(aiUnavailable()).toBe("ledger");
    expect(checkAiAccess(req())).toBe("ledger");
    const status = await (await statusGET(new NextRequest("http://localhost/api/ai/status"))).json();
    expect(status).toEqual({ available: false, reason: "ledger" });
  });
});
