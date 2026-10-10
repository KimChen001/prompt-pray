// A real Postgres ledger for tests: PGlite in memory, all migrations plus the test clock, and a
// plan synced from a small editable description. Every ledger test checks audit() after each step.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { pgliteExecutor, type SqlExecutor } from "@/lib/ledger/drivers";
import { migrate } from "@/lib/ledger/migrate";
import { createSqlLedger } from "@/lib/ledger/sql-ledger";
import type { AdminLedger, ReserveOutcome, ReserveRequest, SyncPlanPayload } from "@/lib/ledger/port";
import { PURPOSES, type Purpose } from "@/lib/ai/types";

export const M = 1_000_000; // micro-USD per USD

export interface TestClock { now: Date; set(iso: string): void; advance(ms: number): void }

export function makeClock(iso = "2026-10-12T12:00:00Z"): TestClock {
  const c: TestClock = {
    now: new Date(iso),
    set(i) { c.now = new Date(i); },
    advance(ms) { c.now = new Date(c.now.getTime() + ms); },
  };
  return c;
}

export interface TestWindow {
  id: string; startsAt: string; endsAt: string; capMicro: number; callsCap?: number | null;
  slice?: { capMicro: number; seconds: 3600 | 86400 } | null; mintCap?: number | null;
  quota?: Partial<Record<Purpose, [number, number]>>; defaultQuota?: [number, number];
}

export interface TestPlan {
  aiMicro: number; packsMicro: number; hostingMicro: number; reserveMicro: number; cashMicro: number;
  windows: TestWindow[];
  inflightCap: number; subjectInflightCap: number; leaseSeconds: number; overrunTripMicro: number;
  unknownTrip: number; unknownCooldownS: number; rlTrip: number; rlWindowS: number; rlCooldownS: number;
  mintNetLimit: number; mintNetWindowS: number; checkoutTtlS: number; packSlackMicro: number;
  product?: { allocMicro: number; feeHoldMicro: number; maxSoldTest: number; maxSoldLive: number; readings: number; followups: number; amountCents: number } | null;
  planId?: string;
}

export function testPlan(o: Partial<TestPlan> = {}): TestPlan {
  return {
    aiMicro: 20 * M, packsMicro: 0, hostingMicro: 0, reserveMicro: 10 * M, cashMicro: 100 * M,
    windows: [{ id: "win:t", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z", capMicro: 10 * M, callsCap: null, slice: null, defaultQuota: [1000, 1000] }],
    inflightCap: 24, subjectInflightCap: 100, leaseSeconds: 120, overrunTripMicro: 500_000,
    unknownTrip: 5, unknownCooldownS: 60, rlTrip: 5, rlWindowS: 60, rlCooldownS: 20,
    mintNetLimit: 400, mintNetWindowS: 600, checkoutTtlS: 1860, packSlackMicro: 1 * M, product: null,
    ...o,
  };
}

export function syncPayload(p: TestPlan): SyncPlanPayload {
  const pools: Record<string, unknown>[] = [
    { id: "ai", kind: "ai", cap_micro: p.aiMicro }, { id: "packs", kind: "packs", cap_micro: p.packsMicro },
    { id: "hosting", kind: "hosting", cap_micro: p.hostingMicro }, { id: "reserve", kind: "reserve", cap_micro: p.reserveMicro },
    ...p.windows.map((w) => ({
      id: w.id, kind: "window", cap_micro: w.capMicro, calls_cap: w.callsCap ?? null, slice_cap_micro: w.slice?.capMicro ?? null,
      slice_seconds: w.slice?.seconds ?? null, mint_cap: w.mintCap ?? null, starts_at: w.startsAt, ends_at: w.endsAt,
    })),
  ];
  const quotas = p.windows.flatMap((w) => PURPOSES.map((purpose) => {
    const [per, failed] = w.quota?.[purpose] ?? w.defaultQuota ?? [1000, 1000];
    return { window_id: w.id, purpose, per_subject: per, failed_cap: failed };
  }));
  const products = p.product ? [{
    id: "tarot5", active: true, amount_cents: p.product.amountCents, currency: "usd", readings: p.product.readings, followups_per_reading: p.product.followups,
    alloc_micro: p.product.allocMicro, fee_hold_micro: p.product.feeHoldMicro, max_sold_test: p.product.maxSoldTest, max_sold_live: p.product.maxSoldLive,
  }] : [];
  const plan = {
    plan_id: p.planId ?? "test", plan_hash: "test", cash_total_micro: p.cashMicro, overrun_trip_micro: p.overrunTripMicro, inflight_cap: p.inflightCap,
    subject_inflight_cap: p.subjectInflightCap, lease_seconds: p.leaseSeconds, unknown_trip: p.unknownTrip, unknown_cooldown_s: p.unknownCooldownS,
    rl_trip: p.rlTrip, rl_window_s: p.rlWindowS, rl_cooldown_s: p.rlCooldownS, mint_net_limit: p.mintNetLimit, mint_net_window_s: p.mintNetWindowS,
    checkout_ttl_s: p.checkoutTtlS, pack_slack_micro: p.packSlackMicro,
  };
  return { plan, pools, quotas, products };
}

export interface TestLedger { ledger: AdminLedger; exec: SqlExecutor; clock: TestClock; close(): Promise<void> }

let template: Promise<SqlExecutor> | null = null;

/** A fresh, migrated, synced ledger. Reuses one PGlite per test file and wipes it between tests. */
export async function makeTestLedger(o: { plan?: TestPlan | null; clock?: TestClock } = {}): Promise<TestLedger> {
  template ??= (async () => {
    const exec = await pgliteExecutor();
    await migrate(exec, { testClock: true });
    return exec;
  })();
  const exec = await template;
  await exec.exec(`
    truncate moona.payment_events, moona.entries, moona.requests, moona.paid_readings, moona.lots, moona.orders, moona.accounts,
      moona.subject_usage, moona.free_quotas, moona.rate_windows, moona.products, moona.plan cascade;
    delete from moona.pools;
    update moona.gate set inflight = 0, unknown_streak = 0, rl_hits = 0, rl_window_start = null, cooldown_until = null,
      breaker = 'ok', breaker_reason = null, overrun_ack_micro = 0, sales = 'open', sales_reason = null;`);
  const clock = o.clock ?? makeClock();
  const ledger = createSqlLedger(exec, { clock: () => clock.now });
  if (o.plan !== null) await ledger.syncPlan(syncPayload(o.plan ?? testPlan()));
  return { ledger, exec, clock, close: async () => undefined };
}

export async function expectAudit(l: AdminLedger) {
  expect(await l.audit()).toEqual([]);
}

/** The request id of a reservation; anything else fails the test with the outcome shown. */
export function reserved(o: ReserveOutcome): string {
  if (o.status !== "reserved") throw new Error(`expected reserved, got ${JSON.stringify(o)}`);
  return o.requestId;
}

/** PGlite start-up and migration are slow when every test file runs at once. */
export const LEDGER_TIMEOUT = { timeout: 60_000 };

export const visitor = () => `v:${randomUUID()}`;
export const hex = (s: string) => Buffer.from(s.padEnd(8, "_")).toString("hex");

let seq = 0;
/** A free reserve request; pass `input` to control cache hits and `id` for idempotency. */
export function freeReq(subjectKey: string, o: Partial<ReserveRequest> & { id?: string; input?: string } = {}): ReserveRequest {
  const { id, input, ...rest } = o;
  const purpose = rest.purpose ?? "tarot";
  return {
    idemKey: hex(`${subjectKey}|${purpose}|${id ?? `r${++seq}`}`), subjectKey, cacheScope: subjectKey, purpose, mode: "free",
    inputHash: hex(`in|${input ?? `x${++seq}`}`), boundMicro: 100_000, ...rest,
  };
}

export async function row<T = Record<string, unknown>>(exec: SqlExecutor, sql: string, params: unknown[] = []): Promise<T> {
  return (await exec.query<T>(sql, params)).rows[0];
}

export async function pool(exec: SqlExecutor, id: string) {
  const r = await row<{ spent_micro: string; held_micro: string; calls_used: number; cap_micro: string; overrun_micro: string }>(exec, "select * from moona.pools where id = $1", [id]);
  return r ? { spent: Number(r.spent_micro), held: Number(r.held_micro), calls: Number(r.calls_used), cap: Number(r.cap_micro), overrun: Number(r.overrun_micro) } : null;
}

/** A fake-mode pack bought and granted: returns the account and its ledger subject. */
export async function grantPack(l: AdminLedger, who = randomUUID()): Promise<{ accountId: string; subjectKey: string; orderId: string }> {
  const accountId = await l.ensureAccount("fake", who);
  const made = await l.createOrder({ accountId, productId: "tarot5", mode: "fake", checkoutKey: `ck-${who}` });
  if (made.status === "denied") throw new Error(`order denied: ${made.reason}`);
  const sessionId = `cs_${who}`;
  await l.attachSession({ orderId: made.order.id, sessionId, url: `https://checkout.invalid/${who}` });
  const out = await l.fulfil({ eventId: `evt_${who}`, type: "checkout.session.completed", orderId: made.order.id, sessionId, paymentId: `pi_${who}`, amountCents: made.order.amountCents, currency: "usd", livemode: false, paid: true });
  if (out !== "granted") throw new Error(`fulfil: ${out}`);
  return { accountId, subjectKey: `a:${accountId}`, orderId: made.order.id };
}

export const PACK_PRODUCT = { allocMicro: 2 * M, feeHoldMicro: 520_000, maxSoldTest: 3, maxSoldLive: 10, readings: 5, followups: 2, amountCents: 500 };
