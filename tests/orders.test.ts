// Orders and recovery (spec §11 orders and recovery): holds are taken before any redirect, an order is
// idempotent on its checkout key, one pending order per account, and an order with a provider session
// is released only by the provider's word (an expired event or a verified retrieve), never a timer.
import { afterEach, describe, expect, it } from "vitest";
import { paymentsConfig, type PaymentsConfig } from "@/lib/payments/config";
import { createFakePayments, resetFakePayments } from "@/lib/payments/fake";
import { PaymentProviderError, type PaymentsPort } from "@/lib/payments/port";
import { reconcile, startCheckout, syncOrder } from "@/lib/payments/service";
import { LEDGER_TIMEOUT, M, PACK_PRODUCT, expectAudit, grantPack, makeTestLedger, pool, row, testPlan } from "./helpers/ledger";

const PLAN = testPlan({ packsMicro: 5 * M, product: PACK_PRODUCT });
const fakeCfg: PaymentsConfig = paymentsConfig({ PAYMENTS_MODE: "fake" }, { ledgerKind: "memory", authKind: "fake" });
const noSink = async () => ({ status: 200, body: { outcome: "dropped" } });
afterEach(() => resetFakePayments());

describe("orders", LEDGER_TIMEOUT, () => {
  it("holds the allocation and the fee, once per checkout key and one pending order per account", async () => {
    const { ledger, exec, clock } = await makeTestLedger({ plan: PLAN });
    const a = await ledger.ensureAccount("fake", "o1");
    const first = await ledger.createOrder({ accountId: a, productId: "tarot5", mode: "fake", checkoutKey: "k1" });
    expect(first.status).toBe("created");
    expect(await pool(exec, "packs")).toMatchObject({ held: PACK_PRODUCT.allocMicro });
    expect(await pool(exec, "ai")).toMatchObject({ held: PACK_PRODUCT.allocMicro });
    expect(await pool(exec, "reserve")).toMatchObject({ held: PACK_PRODUCT.feeHoldMicro });
    if (first.status !== "denied") expect(Date.parse(first.order.checkoutExpiresAt) - clock.now.getTime()).toBe(1860_000);
    expect((await ledger.createOrder({ accountId: a, productId: "tarot5", mode: "fake", checkoutKey: "k1" })).status).toBe("existing");
    expect((await ledger.createOrder({ accountId: a, productId: "tarot5", mode: "fake", checkoutKey: "k2" })).status).toBe("pending_exists");
    expect(await pool(exec, "packs")).toMatchObject({ held: PACK_PRODUCT.allocMicro });
    await expectAudit(ledger);
  });

  it("counts sold packs per mode, and closes when money or the flag says so", async () => {
    const { ledger } = await makeTestLedger({ plan: testPlan({ packsMicro: 20 * M, aiMicro: 30 * M, product: { ...PACK_PRODUCT, maxSoldTest: 2, maxSoldLive: 1 } }) });
    await grantPack(ledger);
    await grantPack(ledger);
    const c = await ledger.ensureAccount("fake", "third");
    expect(await ledger.createOrder({ accountId: c, productId: "tarot5", mode: "test", checkoutKey: "t3" })).toEqual({ status: "denied", reason: "sold_out" });
    expect((await ledger.createOrder({ accountId: c, productId: "tarot5", mode: "live", checkoutKey: "l1" })).status).toBe("created"); // live is counted apart
    await ledger.setFlag("sales", "closed", "test");
    const d = await ledger.ensureAccount("fake", "fourth");
    expect(await ledger.createOrder({ accountId: d, productId: "tarot5", mode: "live", checkoutKey: "l2" })).toEqual({ status: "denied", reason: "sales_closed" });
    await ledger.setFlag("sales", "open", "test");
    await ledger.setFlag("breaker", "tripped", "test");
    expect(await ledger.createOrder({ accountId: d, productId: "tarot5", mode: "live", checkoutKey: "l2" })).toEqual({ status: "denied", reason: "sales_closed" });
    await expectAudit(ledger);
  });

  it("says budget_short when the pack pool or the reserve can't cover a new order", async () => {
    const tight = await makeTestLedger({ plan: testPlan({ packsMicro: PACK_PRODUCT.allocMicro + 500_000, packSlackMicro: 1 * M, product: PACK_PRODUCT }) });
    const a = await tight.ledger.ensureAccount("fake", "short");
    expect(await tight.ledger.createOrder({ accountId: a, productId: "tarot5", mode: "fake", checkoutKey: "s1" })).toEqual({ status: "denied", reason: "budget_short" });
    const fee = await makeTestLedger({ plan: testPlan({ packsMicro: 5 * M, reserveMicro: 100_000, product: PACK_PRODUCT }) });
    const b = await fee.ledger.ensureAccount("fake", "fee");
    expect(await fee.ledger.createOrder({ accountId: b, productId: "tarot5", mode: "fake", checkoutKey: "f1" })).toEqual({ status: "denied", reason: "budget_short" });
    await expectAudit(fee.ledger);
  });

  it("attaches a session once, and not after the order closed", async () => {
    const { ledger, clock } = await makeTestLedger({ plan: PLAN });
    const a = await ledger.ensureAccount("fake", "att");
    const o = await ledger.createOrder({ accountId: a, productId: "tarot5", mode: "fake", checkoutKey: "a1" });
    if (o.status === "denied") throw new Error(o.reason);
    expect(await ledger.attachSession({ orderId: o.order.id, sessionId: "cs_1", url: "u" })).toBe("attached");
    expect(await ledger.attachSession({ orderId: o.order.id, sessionId: "cs_1", url: "u" })).toBe("attached");
    expect(await ledger.attachSession({ orderId: o.order.id, sessionId: "cs_other", url: "u" })).toBe("not_pending");
    const b = await ledger.ensureAccount("fake", "att2");
    const p = await ledger.createOrder({ accountId: b, productId: "tarot5", mode: "fake", checkoutKey: "a2" });
    if (p.status === "denied") throw new Error(p.reason);
    clock.advance(11 * 60_000);
    await ledger.reap(); // no session after 10 minutes: canceled
    expect(await ledger.attachSession({ orderId: p.order.id, sessionId: "cs_2", url: "u" })).toBe("not_pending");
    await expectAudit(ledger);
  });

  it("returns the checkout only after the session is attached", async () => {
    const { ledger, exec } = await makeTestLedger({ plan: PLAN });
    const pay = createFakePayments(fakeCfg, noSink);
    const accountId = await ledger.ensureAccount("fake", "co");
    const out = await startCheckout({ ledger, pay, accountId, productId: "tarot5", checkoutKey: "checkout-key-0001", siteUrl: "http://localhost:3000" });
    if ("denied" in out) throw new Error(out.denied);
    expect(out.url).toBe(`/packs/fake-checkout/${out.orderId}`);
    expect(await row(exec, "select provider_session_id, checkout_url from moona.orders")).toEqual({ provider_session_id: `cs_fake_${out.orderId}`, checkout_url: out.url });
    // the same key resumes the same checkout
    expect(await startCheckout({ ledger, pay, accountId, productId: "tarot5", checkoutKey: "checkout-key-0001", siteUrl: "http://localhost:3000" })).toEqual(out);
    await expectAudit(ledger);
  });
});

describe("recovery", LEDGER_TIMEOUT, () => {
  it("never releases an order with a session on a timer, only on the provider's word", async () => {
    const { ledger, exec, clock } = await makeTestLedger({ plan: PLAN });
    const pay = createFakePayments(fakeCfg, noSink);
    const accountId = await ledger.ensureAccount("fake", "rec");
    const out = await startCheckout({ ledger, pay, accountId, productId: "tarot5", checkoutKey: "recover-key-00001", siteUrl: "http://x" });
    if ("denied" in out) throw new Error(out.denied);
    clock.advance(3 * 3600_000);
    await ledger.reap();
    expect(await row(exec, "select state, holds from moona.orders")).toEqual({ state: "pending", holds: true });
    // the provider is unreachable: the hold stays
    const down: PaymentsPort = { ...pay, retrieve: () => Promise.reject(new PaymentProviderError("unreachable")) };
    expect((await reconcile(ledger, down)).ordersSynced).toBe(0);
    expect(await row(exec, "select state, holds from moona.orders")).toEqual({ state: "pending", holds: true });
    // the provider says it expired: released
    await pay.expire(`cs_fake_${out.orderId}`);
    expect((await reconcile(ledger, pay)).ordersSynced).toBe(1);
    expect(await row(exec, "select state, holds from moona.orders")).toEqual({ state: "expired", holds: false });
    expect(await pool(exec, "packs")).toMatchObject({ held: 0 });
    await expectAudit(ledger);
  });

  it("grants from a verified retrieve when the webhook is late, exactly once", async () => {
    const { ledger, exec } = await makeTestLedger({ plan: PLAN });
    const pay = createFakePayments(fakeCfg, noSink);
    const accountId = await ledger.ensureAccount("fake", "late");
    const out = await startCheckout({ ledger, pay, accountId, productId: "tarot5", checkoutKey: "late-webhook-0001", siteUrl: "http://x" });
    if ("denied" in out) throw new Error(out.denied);
    expect((await syncOrder(ledger, pay, out.orderId, accountId))?.state).toBe("pending"); // not paid yet
    await pay.deliver(out.orderId, "pay"); // the provider has the payment; its webhook is dropped
    expect((await syncOrder(ledger, pay, out.orderId, accountId))?.state).toBe("paid");
    expect((await syncOrder(ledger, pay, out.orderId, accountId))?.state).toBe("paid");
    expect((await row<{ n: number }>(exec, "select count(*)::int as n from moona.lots")).n).toBe(1);
    expect(await syncOrder(ledger, pay, out.orderId, await ledger.ensureAccount("fake", "someone-else"))).toBeNull();
    await expectAudit(ledger);
  });

  it("releases test and fake packs when going live", async () => {
    const { ledger, exec } = await makeTestLedger({ plan: PLAN });
    await grantPack(ledger);
    const a = await ledger.ensureAccount("fake", "pend");
    await ledger.createOrder({ accountId: a, productId: "tarot5", mode: "test", checkoutKey: "p1" });
    expect(await ledger.revokeMode()).toBe(2);
    expect((await exec.query("select state from moona.orders order by state")).rows).toEqual([{ state: "canceled" }, { state: "revoked" }]);
    expect((await row<{ state: string }>(exec, "select state from moona.lots")).state).toBe("revoked");
    expect(await pool(exec, "packs")).toMatchObject({ held: 0 });
    await expectAudit(ledger);
  });
});
