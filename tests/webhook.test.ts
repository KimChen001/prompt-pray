// The payment webhook through its route, signed with the official Stripe SDK offline (spec §11
// webhook). Test-mode configuration with placeholder values: no key is real and no network is used.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import Stripe from "stripe";
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";
import { setLedgerForTests } from "@/lib/ledger/factory";
import { LedgerUnavailable, type LedgerPort } from "@/lib/ledger/port";
import { LEDGER_TIMEOUT, M, PACK_PRODUCT, expectAudit, hex, makeTestLedger, pool, reserved, row, testPlan, type TestLedger } from "./helpers/ledger";

const SECRET = "whsec_test_placeholder_for_offline_tests";
const stripe = new Stripe("sk_test_offline_placeholder", { maxNetworkRetries: 0 });
let n = 0;
const sessionEvent = (type: string, o: { orderId: string; sessionId: string; paid?: boolean; amount?: number; currency?: string; livemode?: boolean }) => ({
  id: `evt_${++n}`, object: "event", type, livemode: o.livemode ?? false, created: Math.floor(Date.now() / 1000),
  data: { object: { id: o.sessionId, object: "checkout.session", client_reference_id: o.orderId, metadata: { order_id: o.orderId }, payment_status: o.paid === false ? "unpaid" : "paid", amount_total: o.amount ?? 500, currency: o.currency ?? "usd", payment_intent: `pi_${o.sessionId}`, livemode: o.livemode ?? false } },
});
const chargeEvent = (type: string, o: { sessionId: string; amount?: number; refunded?: number }) => ({
  id: `evt_${++n}`, object: "event", type, livemode: false, created: Math.floor(Date.now() / 1000),
  data: { object: { id: `ch_${n}`, object: type.includes("dispute") ? "dispute" : "charge", payment_intent: `pi_${o.sessionId}`, amount: o.amount ?? 500, amount_refunded: o.refunded ?? 500 } },
});

async function send(event: unknown, o: { secret?: string; timestamp?: number; rewrite?: (raw: string) => string } = {}) {
  const payload = JSON.stringify(event);
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: o.secret ?? SECRET, ...(o.timestamp ? { timestamp: o.timestamp } : {}) });
  const body = o.rewrite ? o.rewrite(payload) : payload;
  const res = await webhookPOST(new NextRequest("http://localhost/api/stripe/webhook", { method: "POST", body, headers: { "stripe-signature": sig, "content-type": "application/json" } }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

let t: TestLedger;
async function pendingOrder(key = `k${++n}`) {
  const accountId = await t.ledger.ensureAccount("test", key);
  const made = await t.ledger.createOrder({ accountId, productId: "tarot5", mode: "test", checkoutKey: key });
  if (made.status === "denied") throw new Error(made.reason);
  const sessionId = `cs_test_${key}`;
  await t.ledger.attachSession({ orderId: made.order.id, sessionId, url: "https://checkout.stripe.test" });
  return { orderId: made.order.id, sessionId, accountId };
}
const writes = async () => (await t.exec.query<{ n: number }>("select (select count(*) from moona.payment_events)::int + (select count(*) from moona.lots)::int as n")).rows[0].n;

beforeEach(async () => {
  for (const [k, v] of Object.entries({ PAYMENTS_MODE: "test", STRIPE_SECRET_KEY: "sk_test_offline_placeholder", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_ID: "price_test_placeholder", MOONA_LEDGER: "memory" })) vi.stubEnv(k, v);
  t = await makeTestLedger({ plan: testPlan({ packsMicro: 10 * M, aiMicro: 30 * M, product: PACK_PRODUCT }) });
  setLedgerForTests(t.ledger);
});
afterEach(() => {
  setLedgerForTests(null);
  vi.unstubAllEnvs();
});

describe("payment webhook", LEDGER_TIMEOUT, () => {
  it("grants a verified payment once", async () => {
    const o = await pendingOrder();
    const ev = sessionEvent("checkout.session.completed", o);
    expect(await send(ev)).toEqual({ status: 200, json: { received: true, outcome: "granted" } });
    expect(await send(ev)).toEqual({ status: 200, json: { received: true, outcome: "duplicate_event" } });
    expect(await send(sessionEvent("checkout.session.async_payment_succeeded", o))).toMatchObject({ json: { outcome: "already" } });
    expect((await row<{ n: number }>(t.exec, "select count(*)::int as n from moona.lots")).n).toBe(1);
    expect((await t.ledger.entitlements(o.accountId)).credits).toBe(5);
    await expectAudit(t.ledger);
  });

  it("refuses bad signatures, stale timestamps and re-serialised bodies without writing anything", async () => {
    const o = await pendingOrder();
    const before = await writes();
    expect(await send(sessionEvent("checkout.session.completed", o), { secret: "whsec_wrong" })).toEqual({ status: 400, json: { code: "bad_signature" } });
    expect(await send(sessionEvent("checkout.session.completed", o), { timestamp: Math.floor(Date.now() / 1000) - 3600 })).toEqual({ status: 400, json: { code: "bad_signature" } });
    expect(await send(sessionEvent("checkout.session.completed", o), { rewrite: (raw) => JSON.stringify(JSON.parse(raw), null, 2) })).toEqual({ status: 400, json: { code: "bad_signature" } });
    expect(await writes()).toBe(before);
  });

  it("waits for a delayed payment, then grants", async () => {
    const o = await pendingOrder();
    expect(await send(sessionEvent("checkout.session.completed", { ...o, paid: false }))).toMatchObject({ json: { outcome: "not_paid" } });
    expect(await send(sessionEvent("checkout.session.async_payment_succeeded", o))).toMatchObject({ json: { outcome: "granted" } });
    await expectAudit(t.ledger);
  });

  it("grants nothing on a session, mode or amount mismatch, and closes sales on a wrong amount", async () => {
    const o = await pendingOrder();
    expect(await send(sessionEvent("checkout.session.completed", { ...o, sessionId: "cs_test_someone_else" }))).toMatchObject({ json: { outcome: "session_mismatch" } });
    expect(await send(sessionEvent("checkout.session.completed", { ...o, livemode: true }))).toEqual({ status: 400, json: { code: "livemode_mismatch" } });
    expect(await send(sessionEvent("checkout.session.completed", { ...o, amount: 100 }))).toMatchObject({ json: { outcome: "amount_mismatch" } });
    expect((await row<{ n: number }>(t.exec, "select count(*)::int as n from moona.lots")).n).toBe(0);
    const snap = await t.ledger.snapshot();
    expect(snap.kind === "sql" && snap.gate.sales).toBe("closed");
    expect(await row(t.exec, "select state, review_note from moona.orders")).toEqual({ state: "needs_review", review_note: "amount_mismatch" });
    await expectAudit(t.ledger);
  });

  it("releases holds on expiry; a later payment re-acquires them or is flagged unfunded", async () => {
    const o = await pendingOrder();
    expect(await send({ ...sessionEvent("checkout.session.expired", o) })).toMatchObject({ json: { outcome: "released" } });
    expect(await pool(t.exec, "packs")).toMatchObject({ held: 0 });
    expect(await send(sessionEvent("checkout.session.completed", o))).toMatchObject({ json: { outcome: "granted" } });
    expect(await send(sessionEvent("checkout.session.expired", o))).toMatchObject({ json: { outcome: "noop" } });
    // the pack pool is now too small for another late payment
    const tight = await pendingOrder();
    await send(sessionEvent("checkout.session.expired", tight));
    await t.ledger.syncPlan((await import("./helpers/ledger")).syncPayload(testPlan({ packsMicro: 2.6 * M, aiMicro: 30 * M, product: PACK_PRODUCT })));
    expect(await send(sessionEvent("checkout.session.completed", tight))).toMatchObject({ json: { outcome: "paid_unfunded" } });
    const snap = await t.ledger.snapshot();
    expect(snap.kind === "sql" && snap.gate.salesReason?.startsWith("paid_unfunded")).toBe(true);
    await expectAudit(t.ledger);
  });

  it("revokes on a full refund or dispute after in-flight readings finish; a partial refund is a review note", async () => {
    const o = await pendingOrder();
    await send(sessionEvent("checkout.session.completed", o));
    const subjectKey = `a:${o.accountId}`;
    const calling = reserved(await t.ledger.reserve({ idemKey: hex("inflight"), subjectKey, accountId: o.accountId, cacheScope: subjectKey, purpose: "tarot", mode: "paid_reading", drawKey: hex("inflight"), inputHash: hex("x"), boundMicro: 100_000, readingHash: hex("r") }));
    expect(await send(chargeEvent("charge.refunded", { sessionId: o.sessionId, refunded: 200 }))).toMatchObject({ json: { outcome: "partial_refund_review" } });
    expect(await send(chargeEvent("charge.refunded", { sessionId: o.sessionId }))).toMatchObject({ json: { outcome: "revoked" } });
    expect((await row<{ state: string }>(t.exec, "select state from moona.lots")).state).toBe("revoking");
    await t.ledger.complete({ requestId: calling, chargedMicro: 30_000, billing: "known", usage: null, result: { value: 1, meta: { provider: "fake", model: "simulated", generatedAt: "2026-10-12T12:00:00Z", source: "simulated" } }, resultTtlSeconds: 60, readingHash: hex("r") });
    expect((await row<{ state: string }>(t.exec, "select state from moona.lots")).state).toBe("revoked");
    expect(await pool(t.exec, "packs")).toMatchObject({ held: 0, spent: 30_000 });
    const d = await pendingOrder();
    await send(sessionEvent("checkout.session.completed", d));
    expect(await send(chargeEvent("charge.dispute.created", { sessionId: d.sessionId }))).toMatchObject({ json: { outcome: "revoked" } });
    await expectAudit(t.ledger);
  });

  it("answers 503 while the ledger is down, so the provider delivers again", async () => {
    const o = await pendingOrder();
    const down: LedgerPort = { ...t.ledger, fulfil: () => Promise.reject(new LedgerUnavailable("ledger_down")) };
    setLedgerForTests(down);
    const ev = sessionEvent("checkout.session.completed", o);
    expect(await send(ev)).toEqual({ status: 503, json: { code: "ledger" } });
    setLedgerForTests(t.ledger);
    expect(await send(ev)).toMatchObject({ json: { outcome: "granted" } });
  });

  it("is off when payments are", async () => {
    vi.stubEnv("PAYMENTS_MODE", "off");
    expect((await send(sessionEvent("checkout.session.completed", { orderId: "x", sessionId: "y" }))).status).toBe(404);
  });
});
