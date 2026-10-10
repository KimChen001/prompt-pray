// Budget plans (spec §11 ledger.plan): sync_plan refuses any split that breaks the $100 total, a
// plan switch closes the old window without losing what it spent, and validatePlan catches unsafe
// operating values before they reach the database.
import { describe, expect, it } from "vitest";
import { aiConfig } from "@/lib/ai/config";
import { PLANS, resolvePlan, validatePlan } from "@/lib/ledger/plans";
import { LEDGER_TIMEOUT, M, expectAudit, freeReq, makeClock, makeTestLedger, pool, reserved, syncPayload, testPlan, visitor } from "./helpers/ledger";

const FAKE = { AI_PROVIDER: "fake" };

describe("sync_plan", LEDGER_TIMEOUT, () => {
  it("raises on overlapping windows, an oversized split, a cap below use, and a pool changing kind", async () => {
    const { ledger } = await makeTestLedger();
    const w = (id: string, s: string, e: string, cap = 1 * M) => ({ id, startsAt: s, endsAt: e, capMicro: cap });
    await expect(ledger.syncPlan(syncPayload(testPlan({ windows: [w("win:a", "2026-10-01T00:00:00Z", "2026-10-20T00:00:00Z"), w("win:b", "2026-10-19T00:00:00Z", "2026-10-30T00:00:00Z")] }))))
      .rejects.toThrow(/windows overlap/);
    await expect(ledger.syncPlan(syncPayload(testPlan({ aiMicro: 10 * M, packsMicro: 1 * M, windows: [w("win:t", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", 10 * M)] }))))
      .rejects.toThrow(/exceed the ai cap/);
    await expect(ledger.syncPlan(syncPayload(testPlan({ aiMicro: 60 * M, hostingMicro: 20 * M, reserveMicro: 30 * M, cashMicro: 100 * M }))))
      .rejects.toThrow(/exceed the cash total/);
    reserved(await ledger.reserve(freeReq(visitor(), { boundMicro: 500_000 })));
    await expect(ledger.syncPlan(syncPayload(testPlan({ windows: [w("win:t", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", 400_000)] }))))
      .rejects.toThrow(/below spent \+ held/);
    const kind = syncPayload(testPlan());
    kind.pools = kind.pools.map((p) => (p.id === "hosting" ? { ...p, kind: "reserve" } : p));
    await expect(ledger.syncPlan(kind)).rejects.toThrow(/would change kind/);
    // a failed sync leaves the earlier plan whole
    await expectAudit(ledger);
  });

  it("closes the old window at a plan switch and counts its spending in the split", async () => {
    const clock = makeClock("2026-10-12T12:00:00Z");
    const { ledger, exec } = await makeTestLedger({ clock, plan: testPlan({ windows: [{ id: "win:dev", startsAt: "2026-01-01T00:00:00Z", endsAt: "2027-01-01T00:00:00Z", capMicro: 10 * M }] }) });
    const id = reserved(await ledger.reserve(freeReq(visitor(), { boundMicro: 300_000 })));
    await ledger.complete({ requestId: id, chargedMicro: 250_000, billing: "known", usage: null, result: { value: 1, meta: { provider: "fake", model: "simulated", generatedAt: clock.now.toISOString(), source: "simulated" } }, resultTtlSeconds: 60 });
    const next = (testingCap: number) => testPlan({ aiMicro: 20 * M, windows: [
      { id: "win:testing", startsAt: "2026-10-09T04:00:00Z", endsAt: "2026-10-28T04:00:00Z", capMicro: testingCap },
      { id: "win:demo", startsAt: "2026-10-28T04:00:00Z", endsAt: "2026-10-29T10:00:00Z", capMicro: 10 * M },
    ] });
    // 10 + 10 + what win:dev already spent (0.25) no longer fits ai = 20
    await expect(ledger.syncPlan(syncPayload(next(10 * M)))).rejects.toThrow(/exceed the ai cap/);
    await ledger.syncPlan(syncPayload(next(9 * M)));
    const dev = await exec.query<{ ends_at: string }>("select ends_at from moona.pools where id = 'win:dev'");
    expect(new Date(dev.rows[0].ends_at).toISOString()).toBe(clock.now.toISOString());
    const snap = await ledger.snapshot();
    expect(snap.kind === "sql" ? snap.activeWindowId : null).toBe("win:testing");
    expect(await pool(exec, "win:dev")).toMatchObject({ spent: 250_000 });
    await expectAudit(ledger);
  });

  it("deletes future windows a new plan no longer lists", async () => {
    const { ledger, exec } = await makeTestLedger({ plan: testPlan({ windows: [
      { id: "win:t", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-10-20T00:00:00Z", capMicro: 5 * M },
      { id: "win:later", startsAt: "2026-10-20T00:00:00Z", endsAt: "2026-11-01T00:00:00Z", capMicro: 5 * M },
    ] }) });
    await ledger.syncPlan(syncPayload(testPlan({ windows: [{ id: "win:t", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-10-20T00:00:00Z", capMicro: 5 * M }] })));
    expect(await pool(exec, "win:later")).toBeNull();
    await expectAudit(ledger);
  });

  it("records prior spend once", async () => {
    const { ledger, exec } = await makeTestLedger();
    expect(await ledger.recordSpend({ entryId: "prior-spend", pools: ["ai", "win:t"], amountMicro: 1_500_000, kind: "prior_spend", note: "Parley testing" })).toBe("recorded");
    expect(await ledger.recordSpend({ entryId: "prior-spend", pools: ["ai", "win:t"], amountMicro: 1_500_000, kind: "prior_spend", note: "Parley testing" })).toBe("duplicate");
    expect(await pool(exec, "ai")).toMatchObject({ spent: 1_500_000 });
    expect(await pool(exec, "win:t")).toMatchObject({ spent: 1_500_000 });
    await expectAudit(ledger);
  });

  it("lowers a live slice no further than what it already used", async () => {
    const plan = (slice: number) => testPlan({ windows: [{ id: "win:t", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z", capMicro: 10 * M, slice: { capMicro: slice, seconds: 3600 } }] });
    const { ledger, exec } = await makeTestLedger({ plan: plan(1 * M) });
    reserved(await ledger.reserve(freeReq(visitor(), { boundMicro: 400_000 })));
    await ledger.syncPlan(syncPayload(plan(100_000)));
    expect(await pool(exec, "slice:win:t:20261012T1200Z")).toMatchObject({ cap: 400_000, held: 400_000 });
    expect(await ledger.reserve(freeReq(visitor()))).toEqual({ status: "denied", reason: "slice_usd" });
    await expectAudit(ledger);
  });
});

describe("resolvePlan and validatePlan", LEDGER_TIMEOUT, () => {
  it("validates the event plan with no errors, and it syncs", async () => {
    const cfg = aiConfig(FAKE);
    const r = resolvePlan({ ...FAKE, MOONA_PLAN: "event-2026-10-28" }, cfg);
    expect(r.plan.id).toBe("event-2026-10-28");
    expect(validatePlan(r, cfg).errors).toEqual([]);
    expect(r.product.feeHoldMicro).toBe(520_000);
    expect(r.product.allocMicro).toBe(5 * (r.bounds.tarot + 2 * r.followupBound));
    const { ledger } = await makeTestLedger({ plan: null, clock: makeClock("2026-10-28T15:00:00Z") });
    await ledger.syncPlan(r.sync);
    const snap = await ledger.snapshot();
    expect(snap.kind === "sql" && [snap.planId, snap.planHash, snap.activeWindowId]).toEqual(["event-2026-10-28", r.hash, "win:demo"]);
    await expectAudit(ledger);
  });

  it("keeps the plan split within the $100 total", () => {
    for (const p of Object.values(PLANS)) {
      const windows = p.windows.reduce((s, w) => s + w.capUsd, 0);
      expect(windows + p.packPoolUsd).toBeLessThanOrEqual(p.aiUsd);
      expect(p.aiUsd + p.hostingUsd + p.reserveUsd).toBeLessThanOrEqual(p.cashTotalUsd);
      expect(p.cashTotalUsd).toBe(100);
    }
  });

  it("applies environment overrides and changes the hash with them", () => {
    const cfg = aiConfig(FAKE);
    const base = resolvePlan({ MOONA_PLAN: "event-2026-10-28" }, cfg);
    const r = resolvePlan({ MOONA_PLAN: "event-2026-10-28", AI_WINDOW_USD: "demo:30", PACK_POOL_USD: "5", AI_DEMO_HOURLY_USD: "0", AI_INFLIGHT_MAX: "12" }, cfg);
    expect(r.plan.windows.find((w) => w.id === "win:demo")).toMatchObject({ capUsd: 30, slice: null });
    expect(r.plan.packPoolUsd).toBe(5);
    expect(r.sync.plan.inflight_cap).toBe(12);
    expect(r.hash).not.toBe(base.hash);
    expect(resolvePlan({ MOONA_PLAN: "event-2026-10-28" }, cfg).hash).toBe(base.hash);
    expect(validatePlan(r, cfg).errors).toEqual([]);
    // an unknown plan name falls back to dev
    expect(resolvePlan({ MOONA_PLAN: "nope" }, cfg).plan.id).toBe("dev");
  });

  it("flags unsafe leases, a small Demo Day call cap, and a pack pool too small to sell", () => {
    const cfg = aiConfig(FAKE);
    const lease = resolvePlan({ MOONA_PLAN: "event-2026-10-28", AI_LEASE_SECONDS: "60" }, cfg);
    expect(validatePlan(lease, cfg).errors.join()).toMatch(/lease \(60s\) must exceed/);
    const calls = resolvePlan({ MOONA_PLAN: "event-2026-10-28" }, cfg);
    calls.plan.windows.find((w) => w.id === "win:demo")!.callsCap = 800;
    expect(validatePlan(calls, cfg).warnings.join()).toMatch(/call cap 800 is below 1000/);
    const packs = resolvePlan({ MOONA_PLAN: "event-2026-10-28" }, cfg);
    expect(validatePlan(packs, cfg, { paymentsOn: true }).warnings.join()).toMatch(/no pack fits/);
    expect(validatePlan(packs, cfg).warnings.join()).not.toMatch(/no pack fits/);
    const over = resolvePlan({ MOONA_PLAN: "event-2026-10-28", PACK_POOL_USD: "5" }, cfg);
    expect(validatePlan(over, cfg).errors.join()).toMatch(/exceed AI/);
    const negative = resolvePlan({ MOONA_PLAN: "event-2026-10-28", AI_INFLIGHT_MAX: "2.5" }, cfg);
    expect(validatePlan(negative, cfg).errors.join()).toMatch(/non-negative integer/);
  });

  it("states every window instant with an explicit offset", () => {
    for (const p of Object.values(PLANS)) for (const w of p.windows) {
      expect(w.startsAt).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
      expect(w.endsAt).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
    }
  });
});
