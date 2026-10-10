// Regressions from the adversarial review of the S2 ledger (2026-10-09): each case failed before its fix.
import { describe, expect, it } from "vitest";
import { aiConfig } from "@/lib/ai/config";
import { canonicalJson } from "@/lib/ledger/hash";
import { ledgerKind } from "@/lib/ledger/factory";
import { migrate } from "@/lib/ledger/migrate";
import { resolvePlan, validatePlan } from "@/lib/ledger/plans";
import { createSqlLedger } from "@/lib/ledger/sql-ledger";
import { LedgerUnavailable, type StoredResult } from "@/lib/ledger/port";
import type { SqlExecutor } from "@/lib/ledger/drivers";
import { LEDGER_TIMEOUT, M, PACK_PRODUCT, expectAudit, freeReq, grantPack, hex, makeClock, makeTestLedger, pool, reserved, row, syncPayload, testPlan, visitor } from "./helpers/ledger";

const RESULT: StoredResult = { value: { text: "r" }, meta: { provider: "fake", model: "simulated", generatedAt: "2026-10-12T12:00:00Z", source: "simulated" } };
const WIN = { id: "win:t", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" };

describe("ledger review regressions", LEDGER_TIMEOUT, () => {
  it("serves a paid reading from a newer pack when the older one can no longer pay", async () => {
    const product = { ...PACK_PRODUCT, allocMicro: 1 * M };
    const { ledger, exec, clock } = await makeTestLedger({ plan: testPlan({ packsMicro: 4 * M, packSlackMicro: 500_000, product: { ...product, maxSoldTest: 5 } }) });
    const one = await grantPack(ledger, "00000000-0000-4000-8000-0000000000a1");
    // a second pack for the same account
    const made = await ledger.createOrder({ accountId: one.accountId, productId: "tarot5", mode: "fake", checkoutKey: "second" });
    if (made.status === "denied") throw new Error(made.reason);
    await ledger.attachSession({ orderId: made.order.id, sessionId: "cs_second", url: "https://checkout.invalid/2" });
    expect(await ledger.fulfil({ eventId: "evt_second", type: "checkout.session.completed", orderId: made.order.id, sessionId: "cs_second", paymentId: "pi_2", amountCents: 500, currency: "usd", livemode: false, paid: true })).toBe("granted");
    // drain the older pack's money with failures of unknown billing
    for (let i = 0; i < 2; i++) {
      const id = reserved(await ledger.reserve({ idemKey: hex(`drain-${i}`), subjectKey: one.subjectKey, accountId: one.accountId, cacheScope: one.subjectKey, purpose: "tarot", mode: "paid_reading", inputHash: hex(`d${i}`), boundMicro: 500_000 }));
      await ledger.fail({ requestId: id, billing: "unknown", usage: null, errorCode: "timeout" });
      clock.advance(1000);
    }
    const next = await ledger.reserve({ idemKey: hex("served"), subjectKey: one.subjectKey, accountId: one.accountId, cacheScope: one.subjectKey, purpose: "tarot", mode: "paid_reading", inputHash: hex("s"), boundMicro: 500_000 });
    expect(next.status).toBe("reserved");
    const lot = await row<{ order_id: string }>(exec, "select lot_id as order_id from moona.requests where idem_key = decode($1, 'hex')", [hex("served")]);
    expect(lot.order_id).toBe(made.order.id);
    expect((await ledger.snapshot()).kind === "sql" && (await ledger.snapshot() as { gate: { sales: string } }).gate.sales).toBe("open");
    await expectAudit(ledger);
  });

  it("refuses a follow-up without the reading's hash", async () => {
    const { ledger } = await makeTestLedger({ plan: testPlan({ packsMicro: 5 * M, product: PACK_PRODUCT }) });
    const b = await grantPack(ledger);
    const id = reserved(await ledger.reserve({ idemKey: hex("p1"), subjectKey: b.subjectKey, accountId: b.accountId, cacheScope: b.subjectKey, purpose: "tarot", mode: "paid_reading", inputHash: hex("p1"), boundMicro: 100_000 }));
    const done = await ledger.complete({ requestId: id, chargedMicro: 10, billing: "known", usage: null, result: RESULT, resultTtlSeconds: 60, readingHash: hex("reading") });
    const paidReadingId = done.status === "succeeded" ? done.request.paidReadingId! : "";
    expect(await ledger.reserve({ idemKey: hex("f1"), subjectKey: b.subjectKey, accountId: b.accountId, cacheScope: b.subjectKey, purpose: "chat", mode: "paid_followup", inputHash: hex("f1"), boundMicro: 50_000, paidReadingId }))
      .toEqual({ status: "denied", reason: "reading_mismatch" });
    await expectAudit(ledger);
  });

  it("never charges less than the bound for bound billing", async () => {
    const { ledger, exec } = await makeTestLedger();
    const v = visitor();
    const id = reserved(await ledger.reserve(freeReq(v, { boundMicro: 100_000 })));
    await ledger.complete({ requestId: id, chargedMicro: 1, billing: "bound", usage: null, result: RESULT, resultTtlSeconds: 60 });
    expect((await row<{ c: number }>(exec, "select charged_micro::int as c from moona.requests where subject_key = $1", [v])).c).toBe(100_000);
    await expectAudit(ledger);
  });

  it("stores a reply containing U+0000", async () => {
    const { ledger } = await makeTestLedger();
    const id = reserved(await ledger.reserve(freeReq(visitor())));
    const out = await ledger.complete({ requestId: id, chargedMicro: 10, billing: "known", usage: null, result: { ...RESULT, value: { text: "a\u0000b" } }, resultTtlSeconds: 60 });
    expect(out.status).toBe("succeeded");
    if (out.status === "succeeded") expect(out.request.result?.value).toEqual({ text: "ab" });
    await expectAudit(ledger);
  });

  it("puts the production clock back when a test-migrated database is migrated normally", async () => {
    const { exec } = await makeTestLedger({ plan: null });
    const clockAt = async () => new Date((await exec.query<{ t: string }>(`select moona._clock('{"now":"2000-01-01T00:00:00Z"}'::jsonb) as t`)).rows[0].t).getUTCFullYear();
    expect(await clockAt()).toBe(2000);
    expect(await migrate(exec)).toEqual(["002"]);
    expect(await clockAt()).not.toBe(2000);
    expect(await migrate(exec, { testClock: true })).toContain("900"); // and the test clock for the other tests
    expect(await clockAt()).toBe(2000);
  });

  it("does not mistake client values in a database error for an outage", async () => {
    const failing = (e: unknown): SqlExecutor => ({ query: () => Promise.reject(e), exec: async () => undefined, close: async () => undefined });
    const pgError = Object.assign(new Error('invalid input syntax for type uuid: "timeout"'), { code: "22P02" });
    await expect(createSqlLedger(failing(pgError)).viewOrder("timeout", "connect")).rejects.toThrow(/invalid input syntax/);
    await expect(createSqlLedger(failing(Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }))).snapshot()).rejects.toBeInstanceOf(LedgerUnavailable);
    await expect(createSqlLedger(failing(new Error("Connection terminated unexpectedly"))).snapshot()).rejects.toBeInstanceOf(LedgerUnavailable);
  });

  it("keeps hourly and daily slices apart when a window changes its slice length", async () => {
    const plan = (seconds: 3600 | 86400, cap: number) => testPlan({ windows: [{ ...WIN, capMicro: 10 * M, slice: { capMicro: cap, seconds } }] });
    const clock = makeClock("2026-10-12T00:30:00Z");
    const { ledger, exec } = await makeTestLedger({ clock, plan: plan(3600, 250_000) });
    reserved(await ledger.reserve(freeReq(visitor(), { boundMicro: 200_000 })));
    await ledger.syncPlan(syncPayload(plan(86400, 5 * M)));
    reserved(await ledger.reserve(freeReq(visitor(), { boundMicro: 200_000 })));
    expect(await pool(exec, "slice:win:t:86400:20261012T0000Z")).toMatchObject({ held: 200_000, cap: 5 * M });
    await expectAudit(ledger);
  });

  it("does not store a late result again after it was purged", async () => {
    const { ledger, exec, clock } = await makeTestLedger();
    const v = visitor();
    const id = reserved(await ledger.reserve(freeReq(v)));
    clock.advance(121_000);
    await ledger.reap();
    await ledger.complete({ requestId: id, chargedMicro: 1, billing: "known", usage: null, result: RESULT, resultTtlSeconds: 60 });
    clock.advance(61_000);
    expect(await ledger.purgeResults()).toBe(1);
    await ledger.complete({ requestId: id, chargedMicro: 1, billing: "known", usage: null, result: RESULT, resultTtlSeconds: 60 });
    expect(await row(exec, "select result, result_purged from moona.requests where subject_key = $1", [v])).toEqual({ result: null, result_purged: true });
    await expectAudit(ledger);
  });

  it("refuses to move a used window into the future", async () => {
    const { ledger } = await makeTestLedger();
    reserved(await ledger.reserve(freeReq(visitor())));
    await expect(ledger.syncPlan(syncPayload(testPlan({ windows: [{ ...WIN, startsAt: "2026-10-20T00:00:00Z", capMicro: 10 * M }] })))).rejects.toThrow(/already used/);
    await expectAudit(ledger);
  });

  it("hashes dates by their value", () => {
    expect(canonicalJson({ at: new Date("2026-10-12T00:00:00Z") })).not.toBe(canonicalJson({ at: new Date("2026-10-13T00:00:00Z") }));
    expect(canonicalJson({ b: 1, a: [new Date(0)] })).toBe('{"a":["1970-01-01T00:00:00.000Z"],"b":1}');
  });

  it("names values the database would refuse, before syncing", () => {
    const cfg = aiConfig({ AI_PROVIDER: "fake" });
    const bad = (env: Record<string, string>) => validatePlan(resolvePlan({ MOONA_PLAN: "event-2026-10-28", ...env }, cfg), cfg).errors.join(" | ");
    expect(bad({ AI_OVERRUN_TRIP_USD: "-1" })).toMatch(/negative/);
    expect(bad({ AI_LEASE_SECONDS: "1000" })).toMatch(/lease seconds/);
    expect(bad({ STORE_CHECKOUT_TTL_S: "600" })).toMatch(/checkout time to live/);
    expect(bad({ STORE_PACK_PRICE_CENTS: "0" })).toMatch(/pack price/);
    expect(bad({ AI_INFLIGHT_MAX: "0" })).toMatch(/in-flight cap/);
    expect(bad({ STORE_FEE_BP: "-5000" })).toMatch(/fee hold/);
    expect(bad({ STORE_ATTEMPTS_PER_UNIT: "1.5" })).toMatch(/attempts per unit/);
    expect(bad({})).toBe("");
  });

  it("never uses an in-memory ledger on a deployment", () => {
    expect(ledgerKind({ MOONA_DEPLOYED: "1", MOONA_LEDGER: "memory" })).toBeNull();
    expect(ledgerKind({ MOONA_LEDGER: "memory" })).toBe("memory");
  });
});
