// Concurrent callers (spec §11 ledger.concurrency). PGlite runs one statement at a time, so this proves
// that each ledger call is atomic, not row locking under real contention (ledger.pg covers that when a
// test database is configured).
import { describe, expect, it } from "vitest";
import { LEDGER_TIMEOUT, M, PACK_PRODUCT, expectAudit, freeReq, hex, makeTestLedger, pool, row, testPlan, visitor } from "./helpers/ledger";

describe("ledger concurrency", LEDGER_TIMEOUT, () => {
  it("admits exactly as many requests as the cap fits", async () => {
    const n = 37, bound = 100_000;
    const { ledger, exec } = await makeTestLedger({ plan: testPlan({ inflightCap: 1000, windows: [{ id: "win:t", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z", capMicro: n * bound }] }) });
    const out = await Promise.all(Array.from({ length: 300 }, () => ledger.reserve(freeReq(visitor(), { boundMicro: bound }))));
    expect(out.filter((o) => o.status === "reserved")).toHaveLength(n);
    expect(out.filter((o) => o.status === "denied" && o.reason === "window_usd")).toHaveLength(300 - n);
    expect(await pool(exec, "win:t")).toMatchObject({ held: n * bound });
    await expectAudit(ledger);
  });

  it("gives one reservation for 20 copies of the same request id", async () => {
    const { ledger } = await makeTestLedger();
    const v = visitor();
    const out = await Promise.all(Array.from({ length: 20 }, () => ledger.reserve(freeReq(v, { id: "same", input: "same" }))));
    expect(out.filter((o) => o.status === "reserved")).toHaveLength(1);
    expect(out.every((o) => ["reserved", "existing", "in_progress"].includes(o.status))).toBe(true);
    await expectAudit(ledger);
  });

  it("grants one lot for 50 identical fulfilments", async () => {
    const { ledger, exec } = await makeTestLedger({ plan: testPlan({ packsMicro: 5 * M, product: PACK_PRODUCT }) });
    const accountId = await ledger.ensureAccount("fake", "buyer");
    const made = await ledger.createOrder({ accountId, productId: "tarot5", mode: "fake", checkoutKey: "k" });
    if (made.status === "denied") throw new Error(made.reason);
    await ledger.attachSession({ orderId: made.order.id, sessionId: "cs_1", url: "https://checkout.invalid/1" });
    const out = await Promise.all(Array.from({ length: 50 }, (_, i) => ledger.fulfil({
      eventId: `evt_${i % 2}`, type: i % 2 ? "checkout.session.async_payment_succeeded" : "checkout.session.completed", orderId: made.order.id,
      sessionId: "cs_1", paymentId: "pi_1", amountCents: 500, currency: "usd", livemode: false, paid: true,
    })));
    expect(out.filter((o) => o === "granted")).toHaveLength(1);
    expect(out.filter((o) => o === "already")).toHaveLength(1);
    expect(out.filter((o) => o === "duplicate_event")).toHaveLength(48);
    expect((await row<{ n: number }>(exec, "select count(*)::int as n from moona.lots")).n).toBe(1);
    await expectAudit(ledger);
  });

  it("serves 40 parallel paid readings from 5 credits without overdrawing", async () => {
    const { ledger, exec } = await makeTestLedger({ plan: testPlan({ packsMicro: 5 * M, product: PACK_PRODUCT, subjectInflightCap: 100 }) });
    const accountId = await ledger.ensureAccount("fake", "p");
    const made = await ledger.createOrder({ accountId, productId: "tarot5", mode: "fake", checkoutKey: "k" });
    if (made.status === "denied") throw new Error(made.reason);
    await ledger.attachSession({ orderId: made.order.id, sessionId: "cs_p", url: "https://checkout.invalid/p" });
    await ledger.fulfil({ eventId: "evt_p", type: "checkout.session.completed", orderId: made.order.id, sessionId: "cs_p", paymentId: "pi_p", amountCents: 500, currency: "usd", livemode: false, paid: true });
    const out = await Promise.all(Array.from({ length: 40 }, (_, i) => ledger.reserve({
      idemKey: hex(`paid-${i}`), subjectKey: `a:${accountId}`, accountId, cacheScope: `a:${accountId}`, purpose: "tarot", mode: "paid_reading", drawKey: hex(`draw-${i}`), inputHash: hex(`in-${i}`), boundMicro: 300_000,
    })));
    expect(out.filter((o) => o.status === "reserved")).toHaveLength(5);
    expect(out.filter((o) => o.status === "denied" && o.reason === "no_credits")).toHaveLength(35);
    expect((await row<{ reserved: number }>(exec, "select readings_reserved as reserved from moona.lots")).reserved).toBe(5);
    await expectAudit(ledger);
  });
});
