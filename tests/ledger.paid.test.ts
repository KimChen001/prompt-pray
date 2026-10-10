// Paid readings and follow-ups on the SQL ledger (spec §11 ledger.paid and ledger.isolation): a pack's
// credits are consumed once, given back on failure, closed when used up, and a pack's money can't be
// reached by free traffic. Every step ends with an empty audit.
import { describe, expect, it } from "vitest";
import type { ReserveRequest, StoredResult } from "@/lib/ledger/port";
import { LEDGER_TIMEOUT, M, PACK_PRODUCT, expectAudit, freeReq, grantPack, hex, makeTestLedger, pool, reserved, row, testPlan, visitor } from "./helpers/ledger";

const RESULT: StoredResult = { value: { text: "paid" }, meta: { provider: "fake", model: "simulated", generatedAt: "2026-10-12T12:00:00Z", source: "simulated" } };
const READING = hex("reading-hash");
let k = 0;
type Buyer = { accountId: string; subjectKey: string; orderId: string };
const reading = (b: Buyer, o: Partial<ReserveRequest> = {}): ReserveRequest => ({ idemKey: hex(`pr-${++k}`), subjectKey: b.subjectKey, accountId: b.accountId, cacheScope: b.subjectKey, purpose: "tarot", mode: "paid_reading", drawKey: hex(`draw-${k}`), inputHash: hex(`in-${k}`), boundMicro: 100_000, readingHash: READING, ...o });
const followup = (b: Buyer, paidReadingId: string, o: Partial<ReserveRequest> = {}): ReserveRequest => ({ idemKey: hex(`fu-${++k}`), subjectKey: b.subjectKey, accountId: b.accountId, cacheScope: b.subjectKey, purpose: "chat", mode: "paid_followup", inputHash: hex(`fin-${k}`), boundMicro: 50_000, readingHash: READING, paidReadingId, ...o });
const done = (requestId: string, chargedMicro = 20_000) => ({ requestId, chargedMicro, billing: "known" as const, usage: null, result: RESULT, resultTtlSeconds: 86_400, readingHash: READING });
const PLAN = testPlan({ packsMicro: 5 * M, product: PACK_PRODUCT });

describe("paid readings", LEDGER_TIMEOUT, () => {
  it("holds a credit, consumes it once, and opens two follow-ups", async () => {
    const { ledger, exec } = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(ledger);
    expect((await ledger.entitlements(b.accountId)).credits).toBe(5);
    const id = reserved(await ledger.reserve(reading(b)));
    expect(await row(exec, "select readings_reserved, alloc_held_micro::int as held from moona.lots")).toEqual({ readings_reserved: 1, held: 100_000 });
    expect((await ledger.entitlements(b.accountId)).credits).toBe(4);
    await expectAudit(ledger);
    const c = await ledger.complete(done(id));
    expect(c.status).toBe("succeeded");
    if (c.status === "succeeded") expect(c.request).toMatchObject({ followupsLeft: 2 });
    expect((await row<{ n: number }>(exec, "select count(*)::int as n from moona.paid_readings")).n).toBe(1);
    expect(await ledger.complete(done(id))).toMatchObject({ status: "already" });
    expect((await row<{ n: number }>(exec, "select count(*)::int as n from moona.paid_readings")).n).toBe(1);
    expect((await ledger.entitlements(b.accountId)).readings).toEqual([expect.objectContaining({ followupsLeft: 2, lotOpen: true })]);
    await expectAudit(ledger);
  });

  it("gives the credit back on failure, and refuses to complete a failed request", async () => {
    const { ledger } = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(ledger);
    const id = reserved(await ledger.reserve(reading(b)));
    await ledger.fail({ requestId: id, billing: "known", chargedMicro: 5_000, usage: null, errorCode: "bad_json" });
    expect((await ledger.entitlements(b.accountId)).credits).toBe(5);
    expect(await ledger.complete(done(id))).toEqual({ status: "conflict" });
    await expectAudit(ledger);
  });

  it("ties follow-ups to their reading and their owner", async () => {
    const { ledger } = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(ledger);
    const other = await grantPack(ledger);
    const c = await ledger.complete(done(reserved(await ledger.reserve(reading(b)))));
    const pr = c.status === "succeeded" ? c.request.paidReadingId! : "";
    for (let i = 0; i < 2; i++) await ledger.complete(done(reserved(await ledger.reserve(followup(b, pr)))));
    expect(await ledger.reserve(followup(b, pr))).toEqual({ status: "denied", reason: "no_followups" });
    expect(await ledger.reserve(followup(b, pr, { readingHash: hex("another reading") }))).toEqual({ status: "denied", reason: "reading_mismatch" });
    expect(await ledger.reserve(followup(other, pr))).toEqual({ status: "denied", reason: "no_such_reading" });
    await expectAudit(ledger);
  });

  it("closes a used-up pack and releases what it didn't spend", async () => {
    const { ledger, exec } = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(ledger);
    for (let r = 0; r < 5; r++) {
      const c = await ledger.complete(done(reserved(await ledger.reserve(reading(b)))));
      const pr = c.status === "succeeded" ? c.request.paidReadingId! : "";
      for (let f = 0; f < 2; f++) await ledger.complete(done(reserved(await ledger.reserve(followup(b, pr)))));
      await expectAudit(ledger);
    }
    expect((await row<{ state: string }>(exec, "select state from moona.lots")).state).toBe("closed");
    const spent = 15 * 20_000;
    expect(await pool(exec, "packs")).toMatchObject({ held: 0, spent });
    expect(await pool(exec, "ai")).toMatchObject({ held: 0, spent });
    expect(await ledger.reserve(reading(b))).toEqual({ status: "denied", reason: "no_credits" });
    await expectAudit(ledger);
  });

  it("draws on the pack slack when a pack's money runs out, then stops sales and keeps the credit", async () => {
    const product = { ...PACK_PRODUCT, allocMicro: 200_000 };
    const { ledger } = await makeTestLedger({ plan: testPlan({ packsMicro: 1 * M, packSlackMicro: 300_000, product }) });
    const b = await grantPack(ledger);
    // two timeouts charge their whole bound and use up the pack's allocation
    for (let i = 0; i < 2; i++) await ledger.fail({ requestId: reserved(await ledger.reserve(reading(b))), billing: "unknown", usage: null, errorCode: "timeout" });
    // the pack pool still has $0.80 of headroom beyond the spent allocation: the next reading draws on it
    const extra = reserved(await ledger.reserve(reading(b, { boundMicro: 700_000 })));
    await ledger.fail({ requestId: extra, billing: "unknown", usage: null, errorCode: "timeout" });
    // $0.10 is left in the pool; a reading that needs $0.20 can't be covered
    expect(await ledger.reserve(reading(b, { boundMicro: 200_000 }))).toEqual({ status: "denied", reason: "paid_capacity" });
    const snap = await ledger.snapshot();
    expect(snap.kind === "sql" && [snap.gate.sales, snap.gate.salesReason?.startsWith("paid_capacity")]).toEqual(["closed", true]);
    const e = await ledger.entitlements(b.accountId);
    expect(e.credits).toBe(5);
    expect(e.unservable).toBe(true);
    await expectAudit(ledger);
  });
});

// Codex's 2026-10-10 review: a page that forgot its pending id (a clock set back, a slow tap, another
// tab) could buy the same draw twice. The draw key (the saved reading's own id) makes it once per draw.
describe("one pack reading per draw", LEDGER_TIMEOUT, () => {
  const DRAW = hex("draw-of-reading-1");
  const credits = async (ledger: Awaited<ReturnType<typeof makeTestLedger>>["ledger"], b: Buyer) => (await ledger.entitlements(b.accountId)).credits;

  it("gives a second request id for the same draw the first one, running or done, and charges once", async () => {
    const { ledger, exec } = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(ledger);
    const first = reserved(await ledger.reserve(reading(b, { drawKey: DRAW })));
    // while the first is still running, the second waits for it (never a second hold)
    expect(await ledger.reserve(reading(b, { drawKey: DRAW }))).toEqual({ status: "in_progress", requestId: first });
    expect(await credits(ledger, b)).toBe(4);
    const c = await ledger.complete(done(first));
    const pr = c.status === "succeeded" ? c.request.paidReadingId : null;
    // once done, any other id for the draw gets that reading back, the same paid reading and follow-ups
    const again = await ledger.reserve(reading(b, { drawKey: DRAW }));
    expect(again.status).toBe("existing");
    if (again.status === "existing") expect(again.request).toMatchObject({ id: first, paidReadingId: pr, followupsLeft: 2 });
    expect(await credits(ledger, b)).toBe(4);
    expect((await row<{ n: number }>(exec, "select count(*)::int as n from moona.paid_readings")).n).toBe(1);
    await expectAudit(ledger);
  });

  it("closes Codex's repro: two ids, one draw, both sent before either finishes", async () => {
    const { ledger, exec } = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(ledger);
    const firstId = reserved(await ledger.reserve(reading(b, { drawKey: DRAW })));
    const second = await ledger.reserve(reading(b, { drawKey: DRAW }));
    expect(second.status).toBe("in_progress"); // no second reservation to complete
    await ledger.complete(done(firstId));
    expect(await credits(ledger, b)).toBe(4);
    expect((await row<{ n: number }>(exec, "select count(*)::int as n from moona.paid_readings")).n).toBe(1);
    await expectAudit(ledger);
  });

  it("answers a replay-only resume under another id with the draw's reading, never 'no such request'", async () => {
    const { ledger } = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(ledger);
    const id = reserved(await ledger.reserve(reading(b, { drawKey: DRAW })));
    await ledger.complete(done(id));
    const resume = await ledger.reserve(reading(b, { drawKey: DRAW, idemKey: hex("a-forgotten-id"), replayOnly: true }));
    expect(resume.status).toBe("existing");
    expect(await credits(ledger, b)).toBe(4);
    // a draw that was never bought is still "no such request" for a replay-only resume
    expect(await ledger.reserve(reading(b, { drawKey: hex("never-bought"), replayOnly: true }))).toEqual({ status: "denied", reason: "no_such_request" });
    await expectAudit(ledger);
  });

  it("treats a new draw of the same cards and question as new, and another account's draw as theirs", async () => {
    const { ledger } = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(ledger);
    const other = await grantPack(ledger);
    await ledger.complete(done(reserved(await ledger.reserve(reading(b, { drawKey: DRAW })))));
    // the same readingHash (cards, topic, question), another draw: a second pack reading
    await ledger.complete(done(reserved(await ledger.reserve(reading(b, { drawKey: hex("draw-of-reading-2") })))));
    expect(await credits(ledger, b)).toBe(3);
    // the same draw key under another account is that account's own draw
    reserved(await ledger.reserve(reading(other, { drawKey: DRAW })));
    expect(await credits(ledger, other)).toBe(4);
    await expectAudit(ledger);
  });

  it("lets a draw be bought again after its attempt failed (the credit came back)", async () => {
    const { ledger } = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(ledger);
    const failed = reserved(await ledger.reserve(reading(b, { drawKey: DRAW })));
    await ledger.fail({ requestId: failed, billing: "known", chargedMicro: 5_000, usage: null, errorCode: "bad_json" });
    expect(await credits(ledger, b)).toBe(5);
    const again = reserved(await ledger.reserve(reading(b, { drawKey: DRAW })));
    expect(again).not.toBe(failed);
    expect(await credits(ledger, b)).toBe(4);
    await expectAudit(ledger);
  });

  it("lets a draw be bought again once its reading is past its time to live (it can't be given back)", async () => {
    const { ledger, clock } = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(ledger);
    const first = reserved(await ledger.reserve(reading(b, { drawKey: DRAW })));
    await ledger.complete(done(first)); // kept for a day in this test
    clock.advance(25 * 3600_000);
    const again = await ledger.reserve(reading(b, { drawKey: DRAW }));
    expect(again.status).toBe("reserved");
    expect(await credits(ledger, b)).toBe(3);
    await expectAudit(ledger);
  });

  it("refuses a pack reading without its draw key", async () => {
    const { ledger } = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(ledger);
    await expect(ledger.reserve(reading(b, { drawKey: undefined }))).rejects.toThrow(/draw key/);
    expect(await credits(ledger, b)).toBe(5);
  });
});

describe("replay-only paid requests", LEDGER_TIMEOUT, () => {
  it("return the subject's earlier answer whatever changed, and can never create or charge", async () => {
    const { ledger, exec } = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(ledger);
    expect(await ledger.reserve(reading(b, { idemKey: hex("never"), replayOnly: true }))).toEqual({ status: "denied", reason: "no_such_request" });
    expect((await row<{ n: number }>(exec, "select count(*)::int as n from moona.requests")).n).toBe(0);
    expect((await ledger.entitlements(b.accountId)).credits).toBe(5);
    const id = reserved(await ledger.reserve(reading(b, { idemKey: hex("first"), inputHash: hex("with-a-note") })));
    await ledger.complete(done(id));
    // the context changed since (a note withdrawn): a normal request with the same id is refused...
    expect(await ledger.reserve(reading(b, { idemKey: hex("first"), inputHash: hex("without-the-note") }))).toEqual({ status: "denied", reason: "key_reused" });
    // ...but replay-only returns the answer that was paid for, without another credit
    const again = await ledger.reserve(reading(b, { idemKey: hex("first"), inputHash: hex("without-the-note"), replayOnly: true }));
    expect(again.status).toBe("existing");
    expect((await ledger.entitlements(b.accountId)).credits).toBe(4);
    await expectAudit(ledger);
  });

  it("answer only for the same spread, or the same pack reading for a follow-up", async () => {
    const { ledger } = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(ledger);
    const first = await ledger.complete(done(reserved(await ledger.reserve(reading(b, { idemKey: hex("spread-a") })))));
    const second = await ledger.complete(done(reserved(await ledger.reserve(reading(b)))));
    const [pr, pr2] = [first, second].map((c) => (c.status === "succeeded" ? c.request.paidReadingId! : ""));
    // the same id asked for another spread (other cards, topic or question): no answer and no charge
    expect(await ledger.reserve(reading(b, { idemKey: hex("spread-a"), inputHash: hex("other"), readingHash: hex("another spread"), replayOnly: true }))).toEqual({ status: "denied", reason: "key_reused" });
    // the same spread with other context (a note withdrawn, another language): the answer paid for
    expect((await ledger.reserve(reading(b, { idemKey: hex("spread-a"), inputHash: hex("other"), replayOnly: true }))).status).toBe("existing");
    const f = reserved(await ledger.reserve(followup(b, pr, { idemKey: hex("fu-a") })));
    await ledger.complete(done(f));
    expect(await ledger.reserve(followup(b, pr2, { idemKey: hex("fu-a"), inputHash: hex("x"), replayOnly: true }))).toEqual({ status: "denied", reason: "key_reused" });
    expect((await ledger.reserve(followup(b, pr, { idemKey: hex("fu-a"), inputHash: hex("x"), replayOnly: true }))).status).toBe("existing");
    const e = await ledger.entitlements(b.accountId);
    expect(e.credits).toBe(3);
    expect(e.readings.map((r) => r.followupsLeft).sort()).toEqual([1, 2]);
    await expectAudit(ledger);
  });

  it("are ignored for free requests: a changed free input is still refused", async () => {
    const { ledger } = await makeTestLedger({ plan: PLAN });
    const v = visitor();
    reserved(await ledger.reserve(freeReq(v, { id: "x", input: "a" })));
    expect(await ledger.reserve(freeReq(v, { id: "x", input: "b", replayOnly: true }))).toEqual({ status: "denied", reason: "key_reused" });
    await expectAudit(ledger);
  });
});

describe("pack money is isolated from free traffic", LEDGER_TIMEOUT, () => {
  it("keeps a pack's allocation and pending holds while free use exhausts its caps", async () => {
    const { ledger, exec } = await makeTestLedger({ plan: testPlan({ aiMicro: 10 * M, packsMicro: 5 * M, windows: [{ id: "win:t", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z", capMicro: 3 * M, defaultQuota: [100_000, 100_000] }], product: PACK_PRODUCT, inflightCap: 1000 }) });
    const b = await grantPack(ledger);
    const pendingAccount = await ledger.ensureAccount("fake", "pending-buyer");
    expect((await ledger.createOrder({ accountId: pendingAccount, productId: "tarot5", mode: "fake", checkoutKey: "pending-1" })).status).toBe("created");
    const before = await exec.query("select order_id, alloc_micro, alloc_spent_micro, alloc_held_micro from moona.lots order by order_id");
    const holds = await exec.query("select id, holds, alloc_micro from moona.orders order by id");
    let last;
    for (let i = 0; i < 200; i++) {
      last = await ledger.reserve(freeReq(visitor(), { boundMicro: 100_000 }));
      if (last.status === "denied") break;
      await ledger.complete({ requestId: reserved(last), chargedMicro: 100_000, billing: "known", usage: null, result: RESULT, resultTtlSeconds: 60 });
    }
    expect(last).toMatchObject({ status: "denied" });
    expect(["window_usd", "total_usd"]).toContain((last as { reason: string }).reason);
    expect((await exec.query("select order_id, alloc_micro, alloc_spent_micro, alloc_held_micro from moona.lots order by order_id")).rows).toEqual(before.rows);
    expect((await exec.query("select id, holds, alloc_micro from moona.orders order by id")).rows).toEqual(holds.rows);
    expect((await ledger.reserve(reading(b))).status).toBe("reserved");
    await expectAudit(ledger);
  });
});
