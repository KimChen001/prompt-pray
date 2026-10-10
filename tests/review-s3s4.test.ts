// Regressions from the adversarial review of S3 (metered AI) and S4 (packs), 2026-10-10: each case
// failed before its fix. Numbers match the review's findings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as horoscopePOST } from "@/app/api/ai/horoscope/route";
import { POST as tarotPOST } from "@/app/api/ai/tarot/route";
import { GET as statusGET } from "@/app/api/ai/status/route";
import { POST as visitorPOST } from "@/app/api/ai/visitor/route";
import { GET as packsGET } from "@/app/api/packs/route";
import { POST as checkoutPOST } from "@/app/api/packs/checkout/route";
import { POST as sessionPOST } from "@/app/api/ops/session/route";
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";
import Stripe from "stripe";
import { setLedgerForTests } from "@/lib/ledger/factory";
import { LedgerUnavailable, type LedgerPort } from "@/lib/ledger/port";
import { serverKeys, fallbackSecret } from "@/lib/identity/keys";
import { OPS_COOKIE, opsCookieValue, verifyOpsCookie } from "@/lib/identity/ops";
import { VISITOR_COOKIE, visitorCookieValue, verifyVisitorCookie } from "@/lib/identity/visitor";
import { DEV_FAKE_WEBHOOK_SECRET, paymentsConfig } from "@/lib/payments/config";
import { createFakePayments, resetFakePayments } from "@/lib/payments/fake";
import { startCheckout } from "@/lib/payments/service";
import { dayHoroscope, horoscopeBody } from "@/lib/astro/horoscope-day";
import { LEDGER_TIMEOUT, M, PACK_PRODUCT, expectAudit, makeTestLedger, row, testPlan, type TestLedger } from "./helpers/ledger";

const OPS = "operator-token-for-tests-0123456789";
const body = (sign: "leo" | "aries") => JSON.parse(JSON.stringify(horoscopeBody(dayHoroscope({ sunSign: sign }, "2026-10-12", "America/New_York"), "2026-10-12", "America/New_York", "en")));
const triad = { locale: "en", spread: "triad", topic: "work", question: "Should I stay at my job?", cards: [{ id: "swords-03", reversed: true }, { id: "major-13", reversed: false }, { id: "pentacles-10", reversed: false }] };
const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 100 } }), { status: 200 });
const good = JSON.stringify({ overall: "A steady day.", love: "Say it.", work: "Finish one." });
const post = (url: string, b: unknown, cookie?: string, ip = "203.0.113.7") => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(b), headers: { "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) } });
const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0];

let t: TestLedger;
beforeEach(async () => {
  vi.stubEnv("AI_API_KEY", "test-key-value");
  vi.stubEnv("MOONA_LEDGER", "memory");
  vi.stubGlobal("fetch", vi.fn(async () => reply(good)));
  t = await makeTestLedger();
  setLedgerForTests(t.ledger);
});
afterEach(() => {
  setLedgerForTests(null);
  resetFakePayments();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("S3/S4 review regressions", LEDGER_TIMEOUT, () => {
  it("1: forgets replies at their time to live, without waiting for a scheduled job", async () => {
    const first = await horoscopePOST(post("/api/ai/horoscope", { ...body("leo"), requestId: "ttl-request-00000001" }));
    const cookie = cookieOf(first)!;
    t.clock.advance(27 * 3600_000); // a shared Sun-sign horoscope is kept for 26 hours
    // any later request runs the reaper, which now also purges
    await horoscopePOST(post("/api/ai/horoscope", { ...body("aries"), requestId: "ttl-request-00000002" }, cookie));
    expect((await row<{ n: number }>(t.exec, "select count(*)::int as n from moona.requests where result is not null and result_expires_at <= $1", [t.clock.now.toISOString()])).n).toBe(0);
    const again = await horoscopePOST(post("/api/ai/horoscope", { ...body("leo"), requestId: "ttl-request-00000001" }, cookie));
    expect(again.status).toBe(409); // retry_new_key: never replayed after its time to live
    await expectAudit(t.ledger);
  });

  it("1: never replays an expired result even if nothing has purged it yet", async () => {
    const first = await horoscopePOST(post("/api/ai/horoscope", { ...body("leo"), requestId: "ttl-request-00000003" }));
    t.clock.advance(27 * 3600_000); // a shared Sun-sign horoscope is kept for 26 hours
    const again = await horoscopePOST(post("/api/ai/horoscope", { ...body("leo"), requestId: "ttl-request-00000003" }, cookieOf(first)));
    expect([again.status, await again.json()]).toEqual([409, { code: "retry_new_key" }]);
  });

  it("2: gives spending and order details to operators only, not to everyone with the venue code", async () => {
    vi.stubEnv("AI_ACCESS_CODE", "venue");
    vi.stubEnv("OPS_TOKEN", OPS);
    await t.ledger.setFlag("sales", "closed", "amount_mismatch 11111111-1111-4111-8111-111111111111");
    const attendee = await (await statusGET(new NextRequest("http://localhost/api/ai/status", { headers: { cookie: "moona-ai-access=venue" } }))).json();
    expect(attendee).not.toHaveProperty("budget");
    expect(JSON.stringify(attendee)).not.toMatch(/amount_mismatch|heldMicro|sold|owed|planMismatch/);
    const ops = await (await statusGET(new NextRequest("http://localhost/api/ai/status", { headers: { cookie: `${OPS_COOKIE}=${opsCookieValue(serverKeys()!)}` } }))).json();
    expect(ops.budget.gate.salesReason).toMatch(/amount_mismatch/);
  });

  it("3: checkout refuses before minting a visitor (venue code, accounts, closed sales)", async () => {
    t = await makeTestLedger({ plan: testPlan({ packsMicro: 5 * M, product: PACK_PRODUCT, windows: [{ id: "win:t", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z", capMicro: 5 * M, mintCap: 5 }] }) });
    setLedgerForTests(t.ledger);
    for (const [k, v] of Object.entries({ PAYMENTS_MODE: "fake", AUTH_PROVIDER: "none", AI_ACCESS_CODE: "venue" })) vi.stubEnv(k, v);
    const minted = async () => (await row<{ n: number }>(t.exec, "select minted as n from moona.pools where id = 'win:t'")).n;
    for (let i = 0; i < 6; i++) expect((await checkoutPOST(post("/api/packs/checkout", { productId: "tarot5", checkoutKey: `mint-attack-key-${String(i).padStart(4, "0")}` }))).status).toBe(503);
    for (let i = 0; i < 6; i++) expect((await checkoutPOST(post("/api/packs/checkout", { productId: "tarot5", checkoutKey: `mint-attack-key-${String(i).padStart(4, "0")}` }, "moona-ai-access=venue"))).status).toBe(401);
    expect(await minted()).toBe(0);
    vi.stubEnv("AUTH_PROVIDER", "fake");
    await t.ledger.setFlag("sales", "closed", "test");
    expect((await checkoutPOST(post("/api/packs/checkout", { productId: "tarot5", checkoutKey: "mint-attack-key-9999" }, "moona-ai-access=venue"))).status).toBe(409);
    expect(await minted()).toBe(0);
    // an attendee can still start
    expect((await horoscopePOST(post("/api/ai/horoscope", body("leo"), "moona-ai-access=venue"))).status).toBe(200);
  });

  it("4: the public sees 'unconfigured' in the sales reason too", async () => {
    for (const [k, v] of Object.entries({ PAYMENTS_MODE: "test", STRIPE_SECRET_KEY: "sk_live_placeholder", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_ID: "price_x" })) vi.stubEnv(k, v);
    const res = await (await packsGET(new NextRequest("http://localhost/api/packs"))).json();
    expect(res).toMatchObject({ payments: { state: "unconfigured" }, sales: { open: false, reason: "unconfigured" } });
  });

  it("6: a reply with a lone surrogate or a literal \\u0000 is stored, never left in flight", async () => {
    const weird = JSON.stringify({ overall: "A steady day \uD800 and \\u0000 too.", love: "Say it.", work: "Finish one." });
    vi.stubGlobal("fetch", vi.fn(async () => reply(weird)));
    const res = await horoscopePOST(post("/api/ai/horoscope", body("leo")));
    expect(res.status).toBe(200);
    expect((await row<{ n: number }>(t.exec, "select count(*)::int as n from moona.requests where state = 'calling'")).n).toBe(0);
    await expectAudit(t.ledger);
  });

  it("6: if the ledger refuses a reply anyway, the request is settled as failed with what was billed", async () => {
    const refusing: LedgerPort = { ...t.ledger, complete: () => Promise.reject(Object.assign(new Error("invalid input syntax for type json"), { code: "22P02" })) };
    setLedgerForTests(refusing);
    const res = await horoscopePOST(post("/api/ai/horoscope", body("leo")));
    expect([res.status, await res.json()]).toEqual([502, { code: "bad_output" }]);
    expect(await row(t.exec, "select state, billing from moona.requests")).toEqual({ state: "failed", billing: "known" });
    await expectAudit(t.ledger);
  });

  it("7: sets the visitor cookie ahead of the first AI request, once, behind the same gates", async () => {
    const first = await visitorPOST(post("/api/ai/visitor", {}));
    expect(first.status).toBe(204);
    const cookie = cookieOf(first)!;
    expect(cookie).toMatch(new RegExp(`^${VISITOR_COOKIE}=v1\\.`));
    const again = await visitorPOST(post("/api/ai/visitor", {}, cookie));
    expect([again.status, again.headers.get("set-cookie")]).toEqual([204, null]);
    // the first AI request then carries it: two copies of it are one request, paid once
    const fetchSpy = vi.fn(async () => reply(good));
    vi.stubGlobal("fetch", fetchSpy);
    const [a, b] = await Promise.all([1, 2].map(() => horoscopePOST(post("/api/ai/horoscope", { ...body("leo"), requestId: "first-request-dup-01" }, cookie))));
    // one runs; the copy either waits (202) or, if the first already finished, replays it (200)
    expect(a.status === 200 || b.status === 200).toBe(true);
    expect([200, 202]).toContain(a.status);
    expect([200, 202]).toContain(b.status);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.stubEnv("AI_ACCESS_CODE", "venue");
    expect((await visitorPOST(post("/api/ai/visitor", {}))).status).toBe(503); // locked: nothing minted
  });

  it("8: a production server without SESSION_SECRET never signs with the public development key", () => {
    const prod = { NODE_ENV: "production" };
    expect(fallbackSecret(prod)).not.toBe(fallbackSecret({ NODE_ENV: "development" }));
    const devKeys = serverKeys({ NODE_ENV: "development" })!;
    const prodKeys = serverKeys(prod)!;
    const forged = visitorCookieValue(devKeys, "4b0c8a8e-2f7a-4d55-9a37-3f1d0c2b9e61");
    expect(verifyVisitorCookie(forged, prodKeys)).toBeNull();
    expect(paymentsConfig({ PAYMENTS_MODE: "fake", NODE_ENV: "production" }, { ledgerKind: "memory", authKind: "fake" }).webhookSecret).not.toBe(DEV_FAKE_WEBHOOK_SECRET);
    expect(paymentsConfig({ PAYMENTS_MODE: "fake", NODE_ENV: "development" }, { ledgerKind: "memory", authKind: "fake" }).webhookSecret).toBe(DEV_FAKE_WEBHOOK_SECRET);
  });

  it("9: a ledger outage while finding the pack account answers 503", async () => {
    vi.stubEnv("AUTH_PROVIDER", "fake");
    setLedgerForTests({ ...t.ledger, ensureAccount: () => Promise.reject(new LedgerUnavailable("ledger_down")) });
    const res = await tarotPOST(post("/api/ai/tarot", { ...triad, use: "paid" }));
    expect([res.status, await res.json()]).toEqual([503, { code: "ledger" }]);
  });

  it("10: rotating OPS_TOKEN signs devices out; failed sign-ins are throttled per network", async () => {
    vi.stubEnv("OPS_TOKEN", OPS);
    const keys = serverKeys()!;
    const cookie = opsCookieValue(keys);
    expect(verifyOpsCookie(cookie, keys)).toBe(true);
    vi.stubEnv("OPS_TOKEN", `${OPS}-rotated`);
    expect(verifyOpsCookie(cookie, keys)).toBe(false);
    vi.stubEnv("OPS_TOKEN", OPS);
    for (let i = 0; i < 10; i++) expect((await sessionPOST(post("/api/ops/session", { token: `wrong-${i}` }, undefined, "198.51.100.9"))).status).toBe(401);
    expect((await sessionPOST(post("/api/ops/session", { token: OPS }, undefined, "198.51.100.10"))).status).toBe(429); // same /24
    expect((await sessionPOST(post("/api/ops/session", { token: OPS }, undefined, "192.0.2.10"))).status).toBe(200); // another network
  });

  it("11: a live setup closed only for selling still processes refunds", async () => {
    for (const [k, v] of Object.entries({ PAYMENTS_MODE: "live", STRIPE_SECRET_KEY: "sk_live_placeholder", STRIPE_WEBHOOK_SECRET: "whsec_live_placeholder", STRIPE_PRICE_ID: "price_placeholder", DATABASE_URL: "postgres://unused.invalid/db", MOONA_LEDGER: "auto" })) vi.stubEnv(k, v);
    const cfg = paymentsConfig(process.env, { ledgerKind: "postgres", authKind: "none" });
    expect(cfg).toMatchObject({ state: "misconfigured", webhookEnabled: true, webhookMode: "live" });
    const stripe = new Stripe("sk_test_offline_placeholder", { maxNetworkRetries: 0 });
    const payload = JSON.stringify({ id: "evt_refund_1", object: "event", type: "charge.refunded", livemode: true, created: Math.floor(Date.now() / 1000), data: { object: { id: "ch_1", payment_intent: "pi_unknown", amount: 500, amount_refunded: 500 } } });
    const res = await webhookPOST(new NextRequest("http://localhost/api/stripe/webhook", { method: "POST", body: payload, headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_live_placeholder" }) } }));
    expect([res.status, await res.json()]).toEqual([200, { received: true, outcome: "unknown_payment" }]);
  });

  it("checks the provider's price before holding anything", async () => {
    t = await makeTestLedger({ plan: testPlan({ packsMicro: 5 * M, product: PACK_PRODUCT }) });
    const pay = { ...createFakePayments(paymentsConfig({ PAYMENTS_MODE: "fake" }, { ledgerKind: "memory", authKind: "fake" })), priceCheck: async () => ({ amountCents: 400, currency: "usd" }) };
    const accountId = await t.ledger.ensureAccount("fake", "price");
    expect(await startCheckout({ ledger: t.ledger, pay, accountId, productId: "tarot5", checkoutKey: "price-check-key-0001", siteUrl: "http://x", expected: { amountCents: 500, currency: "usd" } })).toEqual({ denied: "price_mismatch" });
    expect((await row<{ n: number }>(t.exec, "select count(*)::int as n from moona.orders")).n).toBe(0);
  });
});
