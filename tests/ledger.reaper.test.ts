// Leases and late results (spec §11 ledger.reaper): a request whose server died is charged its bound
// and its quota slot is released; a result arriving after that is kept for replay but moves no money.
import { describe, expect, it } from "vitest";
import type { StoredResult } from "@/lib/ledger/port";
import { LEDGER_TIMEOUT, PACK_PRODUCT, expectAudit, freeReq, makeTestLedger, pool, reserved, row, testPlan, visitor } from "./helpers/ledger";

const RESULT: StoredResult = { value: { text: "late" }, meta: { provider: "fake", model: "simulated", generatedAt: "2026-10-12T12:00:00Z", source: "simulated" } };

describe("reaper", LEDGER_TIMEOUT, () => {
  it("charges an expired lease its bound on the next reserve and releases the visitor's slot", async () => {
    const { ledger, exec, clock } = await makeTestLedger();
    const v = visitor();
    const id = reserved(await ledger.reserve(freeReq(v, { id: "lost", input: "lost", boundMicro: 100_000 })));
    clock.advance(119_000);
    reserved(await ledger.reserve(freeReq(visitor()))); // lease not yet over
    expect((await row<{ state: string }>(exec, "select state from moona.requests where id = $1", [id])).state).toBe("calling");
    clock.advance(2_000);
    reserved(await ledger.reserve(freeReq(visitor())));
    expect(await row(exec, "select state, charged_micro::int as charged, billing, error_code from moona.requests where id = $1", [id]))
      .toEqual({ state: "expired", charged: 100_000, billing: "bound", error_code: "lease_expired" });
    expect(await row(exec, "select reserved, used, failed from moona.subject_usage where subject_key = $1", [v])).toEqual({ reserved: 0, used: 0, failed: 1 });
    const snap = await ledger.snapshot();
    expect(snap.kind === "sql" && snap.gate.inflight).toBe(2); // the two later requests, still within their leases
    await expectAudit(ledger);
  });

  it("keeps a late result for replay without moving money, and refuses a late failure", async () => {
    const { ledger, exec, clock } = await makeTestLedger();
    const v = visitor();
    const late = reserved(await ledger.reserve(freeReq(v, { id: "a", input: "a" })));
    const lateFail = reserved(await ledger.reserve(freeReq(v, { id: "b", input: "b" })));
    clock.advance(121_000);
    expect(await ledger.reap()).toBe(2);
    const before = await pool(exec, "win:t");
    expect(await ledger.complete({ requestId: late, chargedMicro: 10, billing: "known", usage: null, result: RESULT, resultTtlSeconds: 600 })).toEqual({ status: "late" });
    expect(await ledger.fail({ requestId: lateFail, billing: "known", chargedMicro: 10, usage: null, errorCode: "bad_json" })).toEqual({ status: "late" });
    expect(await pool(exec, "win:t")).toEqual(before);
    const replay = await ledger.reserve(freeReq(v, { id: "a", input: "a" }));
    expect(replay.status).toBe("existing");
    if (replay.status === "existing") expect(replay.request).toMatchObject({ state: "expired", result: RESULT });
    await expectAudit(ledger);
  });

  it("purges results after their time to live", async () => {
    const { ledger, clock } = await makeTestLedger();
    const v = visitor();
    const id = reserved(await ledger.reserve(freeReq(v, { id: "a", input: "a" })));
    await ledger.complete({ requestId: id, chargedMicro: 10, billing: "known", usage: null, result: RESULT, resultTtlSeconds: 600 });
    expect(await ledger.purgeResults()).toBe(0);
    clock.advance(601_000);
    expect(await ledger.purgeResults()).toBe(1);
    const again = await ledger.reserve(freeReq(v, { id: "a", input: "a" }));
    expect(again.status).toBe("existing"); // the route answers retry_new_key: the text is gone
    if (again.status === "existing") expect(again.request).toMatchObject({ state: "succeeded", result: null });
    // and the same input is no longer served from the cache
    expect((await ledger.reserve(freeReq(v, { id: "b", input: "a" }))).status).toBe("reserved");
    await expectAudit(ledger);
  });

  it("cancels an order that never reached checkout after 10 minutes", async () => {
    const { ledger, exec, clock } = await makeTestLedger({ plan: testPlan({ packsMicro: 5_000_000, windows: [{ id: "win:t", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z", capMicro: 10_000_000 }], product: PACK_PRODUCT }) });
    const accountId = await ledger.ensureAccount("fake", "crash");
    const made = await ledger.createOrder({ accountId, productId: "tarot5", mode: "fake", checkoutKey: "k1" });
    expect(made.status).toBe("created");
    expect(await pool(exec, "packs")).toMatchObject({ held: 2_000_000 });
    clock.advance(9 * 60_000);
    await ledger.reap();
    expect(await pool(exec, "packs")).toMatchObject({ held: 2_000_000 });
    clock.advance(61_000);
    await ledger.reap();
    expect(await pool(exec, "packs")).toMatchObject({ held: 0 });
    expect(await pool(exec, "reserve")).toMatchObject({ held: 0 });
    await expectAudit(ledger);
  });
});
