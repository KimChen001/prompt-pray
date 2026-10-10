// Seeded random operations against the SQL ledger, free mode (spec §11 ledger.fuzz; the paid steps
// join in S4). After every step audit() is empty, which covers spent + held <= cap + overrun for every
// pool and every counter against its detail rows; the schema's checks forbid negative counters; and
// a request that has left "calling" never changes again. A second walk adds packs: orders, duplicate
// and out-of-order payment events, refunds, disputes, revoke-mode, paid readings and follow-ups.
// LEDGER_FUZZ_FULL=1 runs the full 21 x 2000 (free) and 12 x 1500 (packs).
import { describe, expect, it } from "vitest";
import { mulberry32 } from "@/lib/tarot/rng";
import { PURPOSES } from "@/lib/ai/types";
import type { Billing, StoredResult } from "@/lib/ledger/port";
import { LEDGER_TIMEOUT, M, PACK_PRODUCT, freeReq, hex, makeClock, makeTestLedger, testPlan, visitor } from "./helpers/ledger";

const FULL = process.env.LEDGER_FUZZ_FULL === "1";
const SEEDS = FULL ? 21 : 3;
const STEPS = FULL ? 2000 : 400;

const RESULT: StoredResult = { value: { text: "f" }, meta: { provider: "fake", model: "simulated", generatedAt: "2026-10-12T12:00:00Z", source: "simulated" } };

async function run(seed: number) {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const clock = makeClock("2026-10-12T22:30:00Z");
  // Three profiles so the walk reaches every kind of denial: tight quotas, provider storms, tight caps.
  const profile = seed % 3;
  const storm = profile === 1, tight = profile === 2;
  const { ledger, exec } = await makeTestLedger({ clock, plan: testPlan({
    aiMicro: 12 * M, inflightCap: 6, subjectInflightCap: 2, leaseSeconds: 120,
    overrunTripMicro: storm ? 20_000 : 400_000, unknownTrip: storm ? 2 : 5, unknownCooldownS: 30, rlTrip: storm ? 2 : 5, rlWindowS: 60, rlCooldownS: 10,
    windows: [
      { id: "win:a", startsAt: "2026-10-12T00:00:00Z", endsAt: "2026-10-13T00:00:00Z", capMicro: 6 * M, callsCap: tight ? 30 : 400, slice: { capMicro: tight ? 250_000 : 3 * M, seconds: 3600 },
        quota: profile === 0 ? { tarot: [3, 6], natal: [1, 3] } : {}, defaultQuota: profile === 0 ? [2, 8] : [30, 12] },
      { id: "win:b", startsAt: "2026-10-13T00:00:00Z", endsAt: "2026-10-14T00:00:00Z", capMicro: tight ? 1_500_000 : 5 * M, callsCap: null, slice: null, defaultQuota: profile === 0 ? [3, 6] : [30, 12] },
    ],
  }) });
  const visitors = Array.from({ length: 4 }, (_, i) => `v:00000000-0000-4000-8000-${String(seed).padStart(6, "0")}${String(i).padStart(6, "0")}`);
  const open: { id: string; bound: number }[] = [];
  const done = new Map<string, { state: string; finished: string }>();
  const counts: Record<string, number> = {};
  const note = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };

  for (let step = 0; step < STEPS; step++) {
    const r = rnd();
    let op = "";
    if (r < 0.38) {
      op = "reserve";
      const v = pick(visitors);
      const bound = int(5_000, 60_000);
      const out = await ledger.reserve(freeReq(v, { purpose: pick(PURPOSES), id: `id${int(0, 40)}`, input: `in${int(0, 8)}`, boundMicro: bound, quotaExempt: rnd() < 0.05 }));
      note(`reserve:${out.status === "denied" ? out.reason : out.status}`);
      if (out.status === "reserved") open.push({ id: out.requestId, bound });
    } else if (r < 0.58 && open.length) {
      op = "complete";
      const [x] = open.splice(int(0, open.length - 1), 1);
      const charge = rnd() < (storm ? 0.15 : 0.03) ? Math.round(x.bound * 1.5) : int(0, x.bound);
      const out = await ledger.complete({ requestId: x.id, chargedMicro: charge, billing: rnd() < 0.1 ? "bound" : "known", usage: null, result: RESULT, resultTtlSeconds: int(60, 3600) });
      note(`complete:${out.status}`);
    } else if (r < 0.74 && open.length) {
      op = "fail";
      const [x] = open.splice(int(0, open.length - 1), 1);
      const billing = pick<Billing>(["none", "known", "unknown", "bound"]);
      const out = await ledger.fail({ requestId: x.id, billing, chargedMicro: billing === "known" ? int(0, x.bound) : undefined, usage: null, errorCode: "fuzz", rateLimited: billing === "none" && rnd() < 0.5, retryAfterS: int(0, 30) });
      note(`fail:${out.status}`);
    } else if (r < 0.78 && open.length) {
      op = "abandon"; // the server died: only the reaper settles it
      open.splice(int(0, open.length - 1), 1);
    } else if (r < 0.84 && done.size) {
      op = "late"; // a retry of something already settled must not move anything
      const id = pick([...done.keys()]);
      const out = rnd() < 0.5
        ? await ledger.complete({ requestId: id, chargedMicro: 1, billing: "known", usage: null, result: RESULT, resultTtlSeconds: 60 })
        : await ledger.fail({ requestId: id, billing: "known", chargedMicro: 1, usage: null, errorCode: "late" });
      expect(["already", "late", "conflict"]).toContain(out.status);
    } else if (r < 0.92) {
      op = "advance";
      clock.advance(rnd() < 0.8 ? int(1, 90) * 1000 : int(5, 40) * 60_000);
    } else if (r < 0.945) {
      op = "reap";
      await ledger.reap(int(1, 50));
    } else if (r < 0.96) {
      op = "purge";
      await ledger.purgeResults();
    } else {
      op = "unpause";
      const s = await ledger.snapshot();
      if (s.kind === "sql" && s.gate.breaker === "tripped") { await ledger.setFlag("breaker", "ok", "fuzz"); note("unpaused"); }
    }

    const bad = await ledger.audit();
    if (bad.length) throw new Error(`seed ${seed} step ${step} (${op}): ${JSON.stringify(bad)}`);
    if (step % 25 === 0 || step === STEPS - 1) {
      const rows = (await exec.query<{ id: string; state: string; finished_at: string | null }>("select id, state, finished_at::text from moona.requests where state <> 'calling'")).rows;
      for (const x of rows) {
        const seen = done.get(x.id);
        if (seen) expect({ state: x.state, finished: x.finished_at }, `seed ${seed} request ${x.id} changed after settling`).toEqual(seen);
        else done.set(x.id, { state: x.state, finished: x.finished_at! });
      }
    }
  }
  // drain: every request ends terminal once the leases pass
  clock.advance(10 * 60_000);
  await ledger.reap(10_000);
  expect((await exec.query<{ n: number }>("select count(*)::int as n from moona.requests where state = 'calling'")).rows[0].n).toBe(0);
  expect(await ledger.audit()).toEqual([]);
  if (process.env.LEDGER_FUZZ_PRINT) console.error(seed, JSON.stringify(counts));
  return counts;
}

describe("ledger fuzz (free)", LEDGER_TIMEOUT, () => {
  it(`keeps every invariant over ${SEEDS} seeds x ${STEPS} steps`, async () => {
    const all: Record<string, number> = {};
    for (let seed = 1; seed <= SEEDS; seed++) for (const [k, n] of Object.entries(await run(seed))) all[k] = (all[k] ?? 0) + n;
    if (process.env.LEDGER_FUZZ_PRINT) console.error(JSON.stringify(all));
    // the walk must actually reach the interesting outcomes, not just succeed
    for (const k of ["reserve:reserved", "reserve:cached", "reserve:existing", "reserve:in_progress", "reserve:key_reused", "reserve:subject_quota", "reserve:subject_busy",
      "reserve:paused", "reserve:cooldown", "reserve:window_usd", "reserve:slice_usd", "complete:succeeded", "complete:late", "fail:failed", "fail:late"]) {
      expect(all[k] ?? 0, k).toBeGreaterThan(0);
    }
    expect(Object.keys(all).filter((k) => k.startsWith("reserve:")).length).toBeGreaterThanOrEqual(8);
  }, FULL ? 1_800_000 : 120_000);
});

const PAID_SEEDS = FULL ? 12 : 2;
const PAID_STEPS = FULL ? 1500 : 400;
const READING = hex("fuzz-reading");

async function runPaid(seed: number) {
  const rnd = mulberry32(seed * 7919);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const clock = makeClock("2026-10-12T12:00:00Z");
  const { ledger, exec } = await makeTestLedger({ clock, plan: testPlan({
    aiMicro: 20 * M, packsMicro: 6 * M, reserveMicro: 10 * M, packSlackMicro: 300_000, inflightCap: 8, subjectInflightCap: 3, overrunTripMicro: 10 * M,
    product: { ...PACK_PRODUCT, allocMicro: 600_000, maxSoldTest: 6, maxSoldLive: 3 },
  }) });
  const accounts = await Promise.all([0, 1, 2].map((i) => ledger.ensureAccount("fake", `fuzz-${seed}-${i}`)));
  const orders: { id: string; accountId: string; mode: "fake" | "test" | "live"; sessionId: string | null; amount: number }[] = [];
  const readings: { id: string; accountId: string }[] = [];
  const open: { id: string; mode: string; bound: number }[] = [];
  const counts: Record<string, number> = {};
  const note = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  const RESULT: StoredResult = { value: { text: "p" }, meta: { provider: "fake", model: "simulated", generatedAt: "2026-10-12T12:00:00Z", source: "simulated" } };

  for (let step = 0; step < PAID_STEPS; step++) {
    const r = rnd();
    let op = "";
    if (r < 0.1) {
      op = "order";
      const accountId = pick(accounts);
      const out = await ledger.createOrder({ accountId, productId: "tarot5", mode: pick(["fake", "test", "live"] as const), checkoutKey: `ck-${int(0, 12)}` });
      note(`order:${out.status === "denied" ? out.reason : out.status}`);
      if (out.status !== "denied" && !orders.some((o) => o.id === out.order.id)) {
        const sessionId = rnd() < 0.9 ? `cs_${out.order.id}` : null;
        if (sessionId) note(`attach:${await ledger.attachSession({ orderId: out.order.id, sessionId, url: "u" })}`);
        orders.push({ id: out.order.id, accountId, mode: out.order.mode, sessionId, amount: out.order.amountCents });
      }
    } else if (r < 0.22 && orders.length) {
      op = "fulfil";
      const o = pick(orders);
      const out = await ledger.fulfil({
        eventId: `evt-${int(0, 40)}`, type: "checkout.session.completed", orderId: o.id, sessionId: rnd() < 0.95 ? o.sessionId ?? "cs_none" : "cs_wrong",
        paymentId: `pi_${o.id}`, amountCents: rnd() < 0.8 ? o.amount : o.amount - 1, currency: "usd", livemode: rnd() < 0.95 ? o.mode === "live" : o.mode !== "live", paid: rnd() < 0.85,
      });
      note(`fulfil:${out}`);
    } else if (r < 0.27 && orders.length) {
      op = "expire";
      const o = pick(orders);
      note(`expire:${await ledger.expireOrder({ eventId: `evx-${int(0, 30)}`, sessionId: o.sessionId ?? "cs_none", kind: pick(["expired", "async_failed"] as const) })}`);
    } else if (r < 0.31 && orders.length) {
      op = "revoke";
      const o = pick(orders);
      note(`revoke:${await ledger.revokeOrder({ eventId: `evr-${int(0, 30)}`, kind: pick(["refund_full", "refund_partial", "dispute"] as const), paymentId: `pi_${o.id}`, orderId: rnd() < 0.5 ? o.id : null })}`);
    } else if (r < 0.32) {
      op = "revoke_mode";
      note(`revoke_mode:${await ledger.revokeMode()}`);
    } else if (r < 0.46) {
      op = "paid_reading";
      const accountId = pick(accounts);
      const bound = int(50_000, 300_000);
      const out = await ledger.reserve({ idemKey: hex(`pr-${seed}-${step}`), subjectKey: `a:${accountId}`, accountId, cacheScope: `a:${accountId}`, purpose: "tarot", mode: "paid_reading", inputHash: hex(`pin-${step}`), boundMicro: bound, readingHash: READING });
      note(`reading:${out.status === "denied" ? out.reason : out.status}`);
      if (out.status === "reserved") open.push({ id: out.requestId, mode: "paid_reading", bound });
    } else if (r < 0.54 && readings.length) {
      op = "followup";
      const pr = pick(readings);
      const accountId = rnd() < 0.9 ? pr.accountId : pick(accounts);
      const bound = int(20_000, 150_000);
      const out = await ledger.reserve({ idemKey: hex(`fu-${seed}-${step}`), subjectKey: `a:${accountId}`, accountId, cacheScope: `a:${accountId}`, purpose: "chat", mode: "paid_followup", inputHash: hex(`fin-${step}`), boundMicro: bound, readingHash: rnd() < 0.92 ? READING : hex("other"), paidReadingId: pr.id });
      note(`followup:${out.status === "denied" ? out.reason : out.status}`);
      if (out.status === "reserved") open.push({ id: out.requestId, mode: "paid_followup", bound });
    } else if (r < 0.68 && open.length) {
      op = "complete";
      const [x] = open.splice(int(0, open.length - 1), 1);
      const out = await ledger.complete({ requestId: x.id, chargedMicro: int(0, x.bound), billing: "known", usage: null, result: RESULT, resultTtlSeconds: 3600, readingHash: x.mode === "paid_reading" ? READING : undefined });
      note(`complete:${out.status}`);
      if (out.status === "succeeded" && out.request.paidReadingId && x.mode === "paid_reading") {
        const owner = (await exec.query<{ account_id: string }>("select account_id from moona.paid_readings where id = $1", [out.request.paidReadingId])).rows[0];
        readings.push({ id: out.request.paidReadingId, accountId: owner.account_id });
      }
    } else if (r < 0.78 && open.length) {
      op = "fail";
      const [x] = open.splice(int(0, open.length - 1), 1);
      const billing = pick<Billing>(["none", "known", "unknown"]);
      note(`fail:${(await ledger.fail({ requestId: x.id, billing, chargedMicro: billing === "known" ? int(0, x.bound) : undefined, usage: null, errorCode: "fuzz" })).status}`);
    } else if (r < 0.81 && open.length) {
      op = "abandon";
      open.splice(int(0, open.length - 1), 1);
    } else if (r < 0.9) {
      op = "advance";
      clock.advance(rnd() < 0.8 ? int(1, 120) * 1000 : int(5, 30) * 60_000);
    } else if (r < 0.94) {
      op = "reap";
      await ledger.reap(int(1, 50));
    } else {
      op = "free";
      const out = await ledger.reserve(freeReq(visitor(), { boundMicro: int(10_000, 80_000) }));
      if (out.status === "reserved") await ledger.complete({ requestId: out.requestId, chargedMicro: 5_000, billing: "known", usage: null, result: RESULT, resultTtlSeconds: 60 });
    }
    const bad = await ledger.audit();
    if (bad.length) throw new Error(`paid seed ${seed} step ${step} (${op}): ${JSON.stringify(bad)}`);
  }
  clock.advance(15 * 60_000);
  await ledger.reap(10_000);
  expect((await exec.query<{ n: number }>("select count(*)::int as n from moona.requests where state = 'calling'")).rows[0].n).toBe(0);
  expect(await ledger.audit()).toEqual([]);
  return counts;
}

describe("ledger fuzz (packs)", LEDGER_TIMEOUT, () => {
  it(`keeps every invariant with payments over ${PAID_SEEDS} seeds x ${PAID_STEPS} steps`, async () => {
    const all: Record<string, number> = {};
    for (let seed = 1; seed <= PAID_SEEDS; seed++) for (const [k, n] of Object.entries(await runPaid(seed))) all[k] = (all[k] ?? 0) + n;
    if (process.env.LEDGER_FUZZ_PRINT) console.error(JSON.stringify(all));
    for (const k of ["order:created", "order:pending_exists", "fulfil:granted", "fulfil:duplicate_event", "fulfil:amount_mismatch", "fulfil:session_mismatch", "expire:released", "revoke:revoked", "reading:reserved", "reading:no_credits", "followup:reserved", "complete:succeeded", "fail:failed"]) {
      expect(all[k] ?? 0, k).toBeGreaterThan(0);
    }
  }, FULL ? 1_800_000 : 120_000);
});
