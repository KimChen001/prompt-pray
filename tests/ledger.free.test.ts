// Free-mode admission and settlement on the real SQL ledger (spec §11 ledger.free). Every step ends
// with an empty audit: each pool, quota and gate counter equals what its detail rows say.
import { describe, expect, it } from "vitest";
import type { StoredResult } from "@/lib/ledger/port";
import { LEDGER_TIMEOUT, M, PACK_PRODUCT, expectAudit, freeReq, grantPack, hex, makeClock, makeTestLedger, pool, reserved, row, testPlan, visitor } from "./helpers/ledger";

const RESULT: StoredResult = { value: { text: "ok" }, meta: { provider: "fake", model: "simulated", generatedAt: "2026-10-12T12:00:00Z", source: "simulated" } };
const done = (requestId: string, chargedMicro = 40_000) => ({ requestId, chargedMicro, billing: "known" as const, usage: null, result: RESULT, resultTtlSeconds: 7200 });
const WIN = { id: "win:t", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" };

describe("free reserve and complete", LEDGER_TIMEOUT, () => {
  it("moves window, slice and ai from held to spent and counts the visitor's use", async () => {
    const { ledger, exec } = await makeTestLedger({ plan: testPlan({ windows: [{ ...WIN, capMicro: 10 * M, slice: { capMicro: 5 * M, seconds: 3600 } }] }) });
    const v = visitor();
    const id = reserved(await ledger.reserve(freeReq(v, { boundMicro: 100_000 })));
    const slice = "slice:win:t:3600:20261012T1200Z";
    expect(await pool(exec, "win:t")).toMatchObject({ held: 100_000, spent: 0, calls: 1 });
    expect(await pool(exec, slice)).toMatchObject({ held: 100_000, spent: 0, calls: 1 });
    expect(await pool(exec, "ai")).toMatchObject({ held: 100_000, spent: 0, calls: 1 });
    await expectAudit(ledger);
    const c = await ledger.complete(done(id, 40_000));
    expect(c.status).toBe("succeeded");
    if (c.status === "succeeded") { expect(c.request.result).toEqual(RESULT); expect(c.overrunMicro).toBe(0); }
    for (const p of ["win:t", slice, "ai"]) expect(await pool(exec, p)).toMatchObject({ held: 0, spent: 40_000, calls: 1 });
    expect(await row(exec, "select used, reserved, failed from moona.subject_usage where subject_key = $1", [v])).toEqual({ used: 1, reserved: 0, failed: 0 });
    await expectAudit(ledger);
  });

  it("replays a saved result, an existing id, and refuses a reused id with new input", async () => {
    const { ledger, exec } = await makeTestLedger();
    const v = visitor();
    const id = reserved(await ledger.reserve(freeReq(v, { id: "a", input: "same" })));
    // a second click while the first is running joins it
    expect(await ledger.reserve(freeReq(v, { id: "b", input: "same" }))).toEqual({ status: "in_progress", requestId: id });
    await ledger.complete(done(id));
    const before = await pool(exec, "win:t");
    const cached = await ledger.reserve(freeReq(v, { id: "c", input: "same" }));
    expect(cached.status).toBe("cached");
    if (cached.status === "cached") expect(cached.request.result).toEqual(RESULT);
    expect(await pool(exec, "win:t")).toEqual(before);
    const again = await ledger.reserve(freeReq(v, { id: "a", input: "same" }));
    expect(again.status).toBe("existing");
    if (again.status === "existing") expect(again.request.id).toBe(id);
    expect(await ledger.reserve(freeReq(v, { id: "a", input: "changed" }))).toEqual({ status: "denied", reason: "key_reused" });
    // another visitor's identical input is not shared (the cache scope is the visitor)
    expect((await ledger.reserve(freeReq(visitor(), { input: "same" }))).status).toBe("reserved");
    await expectAudit(ledger);
  });

  it("keeps the cost cap and the call cap independent", async () => {
    const calls = await makeTestLedger({ plan: testPlan({ windows: [{ ...WIN, capMicro: 10 * M, callsCap: 2 }] }) });
    for (let i = 0; i < 2; i++) await calls.ledger.complete(done(reserved(await calls.ledger.reserve(freeReq(visitor())))));
    expect(await calls.ledger.reserve(freeReq(visitor()))).toEqual({ status: "denied", reason: "window_calls" });
    await expectAudit(calls.ledger);

    const money = await makeTestLedger({ plan: testPlan({ windows: [{ ...WIN, capMicro: 250_000, callsCap: 100 }] }) });
    reserved(await money.ledger.reserve(freeReq(visitor())));
    reserved(await money.ledger.reserve(freeReq(visitor())));
    expect(await money.ledger.reserve(freeReq(visitor()))).toEqual({ status: "denied", reason: "window_usd" });
    await expectAudit(money.ledger);
  });

  it("trips the hourly slice before the window, and admits again next hour", async () => {
    const { ledger, clock } = await makeTestLedger({ plan: testPlan({ windows: [{ ...WIN, capMicro: 10 * M, slice: { capMicro: 250_000, seconds: 3600 } }] }) });
    reserved(await ledger.reserve(freeReq(visitor())));
    reserved(await ledger.reserve(freeReq(visitor())));
    expect(await ledger.reserve(freeReq(visitor()))).toEqual({ status: "denied", reason: "slice_usd" });
    clock.advance(3600_000);
    reserved(await ledger.reserve(freeReq(visitor())));
    await expectAudit(ledger);
  });

  it("denies the 4th request when the total fits 3 bounds and one short", async () => {
    const b = 100_000, cap = 3 * b + (b - 1);
    const { ledger } = await makeTestLedger({ plan: testPlan({ aiMicro: cap, windows: [{ ...WIN, capMicro: cap }] }) });
    for (let i = 0; i < 3; i++) reserved(await ledger.reserve(freeReq(visitor(), { boundMicro: b })));
    expect(await ledger.reserve(freeReq(visitor(), { boundMicro: b }))).toEqual({ status: "denied", reason: "total_usd" });
    await expectAudit(ledger);
  });

  it("enforces the per-visitor quota; operators skip it but not the money caps", async () => {
    const { ledger } = await makeTestLedger({ plan: testPlan({ windows: [{ ...WIN, capMicro: 350_000, quota: { tarot: [2, 5] } }] }) });
    const v = visitor();
    await ledger.complete(done(reserved(await ledger.reserve(freeReq(v)))));
    reserved(await ledger.reserve(freeReq(v))); // reserved slots count too
    expect(await ledger.reserve(freeReq(v))).toEqual({ status: "denied", reason: "subject_quota" });
    // a different purpose has its own quota
    reserved(await ledger.reserve(freeReq(v, { purpose: "chat" })));
    reserved(await ledger.reserve(freeReq(v, { quotaExempt: true })));
    expect(await ledger.reserve(freeReq(v, { quotaExempt: true, subjectKey: visitor() }))).toEqual({ status: "denied", reason: "window_usd" });
    await expectAudit(ledger);
  });

  it("settles failures by billing certainty", async () => {
    const { ledger, exec } = await makeTestLedger();
    const v = visitor();
    const none = reserved(await ledger.reserve(freeReq(v, { boundMicro: 100_000 })));
    expect(await ledger.fail({ requestId: none, billing: "none", usage: null, errorCode: "bad_request" })).toEqual({ status: "failed", chargedMicro: 0, overrunMicro: 0 });
    expect(await pool(exec, "win:t")).toMatchObject({ held: 0, spent: 0, calls: 0 }); // the call is refunded
    expect(await row(exec, "select used, reserved, failed from moona.subject_usage where subject_key = $1", [v])).toEqual({ used: 0, reserved: 0, failed: 0 });
    const known = reserved(await ledger.reserve(freeReq(v, { boundMicro: 100_000 })));
    expect(await ledger.fail({ requestId: known, billing: "known", chargedMicro: 30_000, usage: null, errorCode: "bad_json" })).toEqual({ status: "failed", chargedMicro: 30_000, overrunMicro: 0 });
    expect(await pool(exec, "win:t")).toMatchObject({ held: 0, spent: 30_000, calls: 1 });
    expect(await ledger.fail({ requestId: known, billing: "known", chargedMicro: 30_000, usage: null, errorCode: "bad_json" })).toEqual({ status: "already" });
    await expectAudit(ledger);
  });

  it("charges the bound for unknown billing and cools down after 5 in a row", async () => {
    const { ledger, exec, clock } = await makeTestLedger();
    for (let i = 0; i < 4; i++) {
      const id = reserved(await ledger.reserve(freeReq(visitor(), { boundMicro: 100_000 })));
      expect(await ledger.fail({ requestId: id, billing: "unknown", usage: null, errorCode: "timeout" })).toMatchObject({ chargedMicro: 100_000 });
    }
    reserved(await ledger.reserve(freeReq(visitor())));
    const id = reserved(await ledger.reserve(freeReq(visitor())));
    await ledger.fail({ requestId: id, billing: "unknown", usage: null, errorCode: "timeout" });
    expect(await ledger.reserve(freeReq(visitor()))).toEqual({ status: "denied", reason: "cooldown", retryAfterS: 60 });
    expect(await pool(exec, "win:t")).toMatchObject({ spent: 500_000 });
    clock.advance(61_000);
    reserved(await ledger.reserve(freeReq(visitor())));
    await expectAudit(ledger);
  });

  it("a success resets the unknown streak", async () => {
    const { ledger } = await makeTestLedger();
    for (let i = 0; i < 4; i++) await ledger.fail({ requestId: reserved(await ledger.reserve(freeReq(visitor()))), billing: "unknown", usage: null, errorCode: "timeout" });
    await ledger.complete(done(reserved(await ledger.reserve(freeReq(visitor())))));
    await ledger.fail({ requestId: reserved(await ledger.reserve(freeReq(visitor()))), billing: "unknown", usage: null, errorCode: "timeout" });
    reserved(await ledger.reserve(freeReq(visitor())));
    await expectAudit(ledger);
  });

  it("stops a visitor after too many charged failures", async () => {
    const { ledger } = await makeTestLedger({ plan: testPlan({ windows: [{ ...WIN, capMicro: 10 * M, quota: { tarot: [10, 2] } }] }) });
    const v = visitor();
    for (let i = 0; i < 2; i++) await ledger.fail({ requestId: reserved(await ledger.reserve(freeReq(v))), billing: "known", chargedMicro: 1000, usage: null, errorCode: "bad_json" });
    expect(await ledger.reserve(freeReq(v))).toEqual({ status: "denied", reason: "subject_failures" });
    await expectAudit(ledger);
  });

  it("caps requests in flight, globally and per visitor", async () => {
    const { ledger } = await makeTestLedger({ plan: testPlan({ inflightCap: 3, subjectInflightCap: 2 }) });
    const v = visitor();
    reserved(await ledger.reserve(freeReq(v)));
    reserved(await ledger.reserve(freeReq(v)));
    expect(await ledger.reserve(freeReq(v))).toEqual({ status: "denied", reason: "subject_busy" });
    reserved(await ledger.reserve(freeReq(visitor())));
    expect(await ledger.reserve(freeReq(visitor()))).toEqual({ status: "denied", reason: "busy" });
    await expectAudit(ledger);
  });

  it("cools down after 5 rate limits within 60 s, not when they are spread out", async () => {
    const fast = await makeTestLedger();
    for (let i = 0; i < 5; i++) {
      await fast.ledger.fail({ requestId: reserved(await fast.ledger.reserve(freeReq(visitor()))), billing: "none", usage: null, errorCode: "rate_limited", rateLimited: true, retryAfterS: 3 });
      fast.clock.advance(5_000);
    }
    expect(await fast.ledger.reserve(freeReq(visitor()))).toMatchObject({ status: "denied", reason: "cooldown" });
    await expectAudit(fast.ledger);

    const slow = await makeTestLedger();
    for (let i = 0; i < 6; i++) {
      await slow.ledger.fail({ requestId: reserved(await slow.ledger.reserve(freeReq(visitor()))), billing: "none", usage: null, errorCode: "rate_limited", rateLimited: true });
      slow.clock.advance(16_000);
    }
    reserved(await slow.ledger.reserve(freeReq(visitor())));
    await expectAudit(slow.ledger);
  });

  it("settles a request into the window it was admitted in", async () => {
    const clock = makeClock("2026-10-28T03:59:59.999Z");
    const { ledger, exec } = await makeTestLedger({ clock, plan: testPlan({ windows: [
      { id: "win:testing", startsAt: "2026-10-09T04:00:00Z", endsAt: "2026-10-28T04:00:00Z", capMicro: 5 * M },
      { id: "win:demo", startsAt: "2026-10-28T04:00:00Z", endsAt: "2026-10-29T10:00:00Z", capMicro: 5 * M },
    ] }) });
    const id = reserved(await ledger.reserve(freeReq(visitor())));
    clock.advance(1);
    const snap = await ledger.snapshot();
    expect(snap.kind === "sql" ? snap.activeWindowId : null).toBe("win:demo");
    await ledger.complete(done(id, 70_000));
    expect(await pool(exec, "win:testing")).toMatchObject({ spent: 70_000, held: 0 });
    expect(await pool(exec, "win:demo")).toMatchObject({ spent: 0, held: 0 });
    await expectAudit(ledger);
  });

  it("denies outside every window, and before a plan is synced", async () => {
    const { ledger } = await makeTestLedger({ clock: makeClock("2026-12-01T00:00:00Z") });
    expect(await ledger.reserve(freeReq(visitor()))).toEqual({ status: "denied", reason: "no_window" });
    const bare = await makeTestLedger({ plan: null });
    expect(await bare.ledger.reserve(freeReq(visitor()))).toEqual({ status: "denied", reason: "plan_unsynced" });
  });

  it("never serves a paid request's result from the free cache", async () => {
    const { ledger } = await makeTestLedger({ plan: testPlan({ packsMicro: 5 * M, windows: [{ ...WIN, capMicro: 10 * M }], product: PACK_PRODUCT }) });
    const buyer = await grantPack(ledger);
    const paid = await ledger.reserve({ idemKey: hex("paid-1"), subjectKey: buyer.subjectKey, accountId: buyer.accountId, cacheScope: "shared", purpose: "tarot", mode: "paid_reading", drawKey: hex("draw-free"), inputHash: hex("in|shared"), boundMicro: 100_000 });
    await ledger.complete({ ...done(reserved(paid)), readingHash: hex("reading") });
    await expectAudit(ledger);
    expect((await ledger.reserve(freeReq(visitor(), { cacheScope: "shared", input: "shared" }))).status).toBe("reserved");
    await expectAudit(ledger);
  });

  it("rejects malformed admissions outright", async () => {
    const { ledger } = await makeTestLedger();
    await expect(ledger.reserve(freeReq(visitor(), { boundMicro: 0 }))).rejects.toThrow(/invalid bound/);
    await expect(ledger.reserve(freeReq("a:00000000-0000-0000-0000-000000000000"))).rejects.toThrow(/free needs visitor subject/);
    await expectAudit(ledger);
  });
});
