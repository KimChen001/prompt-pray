// The maintenance pause around a migration or deploy (Codex's review of 6e8385c): closing sales alone
// let packs already sold keep arriving, so "nothing in flight" was never a drain. The pause also trips
// the breaker; requests already running settle and saved answers replay; finishing checks the version,
// grants and audit and puts back exactly the state from before (never clearing a trip it didn't make).
import { describe, expect, it } from "vitest";
import type { ReserveRequest, StoredResult } from "@/lib/ledger/port";
import { maintenanceDrain, maintenanceFinish, maintenanceStart, maintenanceStatus } from "@/lib/ledger/maintenance";
import { migrate } from "@/lib/ledger/migrate";
import { LEDGER_FUNCTIONS_VERSION } from "@/lib/ledger/version";
import { LEDGER_TIMEOUT, M, PACK_PRODUCT, expectAudit, freeReq, grantPack, hex, makeTestLedger, reserved, row, testPlan, visitor } from "./helpers/ledger";

const RESULT: StoredResult = { value: { text: "paid" }, meta: { provider: "fake", model: "simulated", generatedAt: "2026-10-12T12:00:00Z", source: "simulated" } };
const READING = hex("reading-hash");
let k = 0;
type Buyer = { accountId: string; subjectKey: string; orderId: string };
const reading = (b: Buyer, o: Partial<ReserveRequest> = {}): ReserveRequest => ({ idemKey: hex(`m-${++k}`), subjectKey: b.subjectKey, accountId: b.accountId, cacheScope: b.subjectKey, purpose: "tarot", mode: "paid_reading", drawKey: hex(`m-draw-${k}`), inputHash: hex(`m-in-${k}`), boundMicro: 100_000, readingHash: READING, ...o });
const done = (requestId: string) => ({ requestId, chargedMicro: 20_000, billing: "known" as const, usage: null, result: RESULT, resultTtlSeconds: 86_400, readingHash: READING });
const PLAN = testPlan({ packsMicro: 5 * M, product: PACK_PRODUCT });
const noSleep = async () => undefined;
const gate = async (t: Awaited<ReturnType<typeof makeTestLedger>>) => row<{ breaker: string; breaker_reason: string | null; sales: string; sales_reason: string | null; overrun_ack_micro: number }>(t.exec, "select breaker, breaker_reason, sales, sales_reason, overrun_ack_micro::int as overrun_ack_micro from moona.gate where id = 1");

describe("the maintenance pause", LEDGER_TIMEOUT, () => {
  it("stops new pack readings and free requests, lets running ones settle and answers replay, then puts the state back", async () => {
    const t = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(t.ledger);
    const running = reserved(await t.ledger.reserve(reading(b, { idemKey: hex("running") })));
    const answeredReq = reading(b, { idemKey: hex("answered") });
    const answered = reserved(await t.ledger.reserve(answeredReq));
    await t.ledger.complete(done(answered));
    const before = await gate(t);
    expect(before).toMatchObject({ breaker: "ok", sales: "open" });

    await maintenanceStart(t.ledger, { id: "m1", note: "migrate 004" });
    // the gap Codex found: with sales closed only, this pack reading would have been reserved
    expect(await t.ledger.reserve(reading(b))).toEqual({ status: "denied", reason: "paused" });
    expect(await t.ledger.reserve(freeReq(visitor()))).toEqual({ status: "denied", reason: "paused" });
    // saved answers still replay, and the request already running still settles
    expect((await t.ledger.reserve(answeredReq)).status).toBe("existing");
    expect(await maintenanceDrain(t.ledger, { timeoutMs: 0, sleep: noSleep })).toBe(1);
    await t.ledger.complete(done(running));
    expect(await maintenanceDrain(t.ledger, { timeoutMs: 1000, sleep: noSleep })).toBe(0);

    await migrate(t.exec, { testClock: true }); // the migration while paused (nothing to apply here)
    expect((await maintenanceFinish(t.ledger, t.exec, { smokeOk: false })).problems).toContain("the new deploy's smoke test is not confirmed (--smoke-ok)");
    expect(await gate(t)).toMatchObject({ breaker: "tripped", sales: "closed" }); // still paused
    const r = await maintenanceFinish(t.ledger, t.exec, { smokeOk: true });
    expect(r.restored).toBe(true);
    expect(r.notes.join(" ")).toMatch(/PGlite/); // no app role here: the grants are checked on Postgres only
    expect(await gate(t)).toEqual(before); // exactly as before, the overrun acknowledgement too
    expect((await t.ledger.reserve(reading(b))).status).toBe("reserved");
    await expectAudit(t.ledger);
  });

  it("never clears a breaker that was already tripped, or sales already closed, before the pause", async () => {
    const t = await makeTestLedger({ plan: PLAN });
    await t.ledger.setFlag("breaker", "tripped", "bound_overrun 1234");
    await t.ledger.setFlag("sales", "closed", "paid_capacity lot-9");
    const before = await gate(t);
    await maintenanceStart(t.ledger, { id: "m2", note: "deploy" });
    const r = await maintenanceFinish(t.ledger, t.exec, { smokeOk: true });
    expect(r.restored).toBe(true);
    expect(await gate(t)).toEqual(before);
    expect(r.notes.join(" ")).toMatch(/already tripped before the pause \(bound_overrun 1234\)/);
  });

  it("leaves a breaker tripped for another reason during the pause for review", async () => {
    const t = await makeTestLedger({ plan: PLAN });
    await maintenanceStart(t.ledger, { id: "m3", note: "deploy" });
    await t.ledger.setFlag("breaker", "tripped", "bound_overrun 77"); // e.g. a running request overran
    const r = await maintenanceFinish(t.ledger, t.exec, { smokeOk: true });
    expect(r.restored).toBe(true);
    expect(await gate(t)).toMatchObject({ breaker: "tripped", breaker_reason: "bound_overrun 77", sales: "open" });
    expect(r.notes.join(" ")).toMatch(/another reason during the pause/);
  });

  it("stays paused when the database runs other functions, the audit fails, or something is still in flight", async () => {
    const t = await makeTestLedger({ plan: PLAN });
    const b = await grantPack(t.ledger);
    const running = reserved(await t.ledger.reserve(reading(b)));
    await maintenanceStart(t.ledger, { id: "m4", note: "migrate" });
    const inflight = await maintenanceFinish(t.ledger, t.exec, { smokeOk: true });
    expect(inflight.restored).toBe(false);
    expect(inflight.problems.join(" ")).toMatch(/1 request\(s\) still in flight/);
    await t.ledger.complete(done(running));
    const restore = `create or replace function moona.functions_version() returns text language sql immutable set search_path = pg_catalog, pg_temp as $$ select '${LEDGER_FUNCTIONS_VERSION}'::text $$;`;
    try {
      await t.exec.exec("create or replace function moona.functions_version() returns text language sql immutable set search_path = pg_catalog, pg_temp as $$ select 'ledger-fns:0123456789ab'::text $$;");
      const stale = await maintenanceFinish(t.ledger, t.exec, { smokeOk: true });
      expect(stale.restored).toBe(false);
      expect(stale.problems.join(" ")).toMatch(/npm run ledger -- migrate/);
    } finally {
      await t.exec.exec(restore);
    }
    await t.exec.exec("update moona.lots set readings_used = readings_used + 1"); // break an invariant
    const broken = await maintenanceFinish(t.ledger, t.exec, { smokeOk: true });
    expect(broken.restored).toBe(false);
    expect(broken.problems.join(" ")).toMatch(/audit/);
    expect(await gate(t)).toMatchObject({ breaker: "tripped", sales: "closed" });
  });

  it("refuses a second pause, and a finish without one", async () => {
    const t = await makeTestLedger({ plan: PLAN });
    expect((await maintenanceFinish(t.ledger, t.exec, { smokeOk: true })).problems).toEqual(["not in maintenance (no saved state in the gate)"]);
    await maintenanceStart(t.ledger, { id: "m5", note: "x" });
    await expect(maintenanceStart(t.ledger, { id: "m6", note: "y" })).rejects.toThrow(/already in maintenance m5/);
    expect(await maintenanceStatus(t.ledger)).toMatchObject({ inMaintenance: true, id: "m5", inflight: 0 });
  });

  it("clears the breaker by hand as before (acknowledging the overrun), but keeps it on a restore", async () => {
    const t = await makeTestLedger({ plan: PLAN });
    await t.exec.exec("update moona.pools set overrun_micro = 900 where id = 'ai'");
    await t.ledger.setFlag("breaker", "tripped", "test");
    await t.ledger.setFlag("breaker", "ok", null, { keepAck: true });
    expect((await gate(t)).overrun_ack_micro).toBe(0);
    await t.ledger.setFlag("breaker", "ok", "operator");
    expect((await gate(t)).overrun_ack_micro).toBe(900);
  });
});
