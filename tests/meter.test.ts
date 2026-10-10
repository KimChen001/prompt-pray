// Metered generation on the real SQL ledger with the offline fake provider (spec §11 meter): the
// provider is called only after "reserved", every outcome settles by billing certainty, a ledger hiccup
// after the call never loses the reading, and spending beyond the bound pauses AI.
import { describe, expect, it, vi } from "vitest";
import { aiConfig } from "@/lib/ai/config";
import { modelCaps } from "@/lib/ai/capabilities";
import { callFake, type FakeScript } from "@/lib/ai/providers/fake";
import { meteredGenerate, type MeterInput } from "@/lib/ai/meter";
import { HOROSCOPE_SCHEMA, horoscopeClaims, horoscopePrompt, parseHoroscopeRequest, referenceSky, validateHoroscope } from "@/lib/ai/horoscope-prompt";
import { dayHoroscope, horoscopeBody } from "@/lib/astro/horoscope-day";
import { serverKeys } from "@/lib/identity/keys";
import { LedgerUnavailable, type LedgerPort } from "@/lib/ledger/port";
import type { JsonRequest } from "@/lib/ai/types";
import { LEDGER_TIMEOUT, expectAudit, makeClock, makeTestLedger, pool, row, testPlan, visitor } from "./helpers/ledger";

const cfg = aiConfig({ AI_PROVIDER: "fake" });
const keys = serverKeys({ SESSION_SECRET: "m".repeat(40) })!;
const DATE = "2026-10-12", TZ = "America/New_York";
const parsed = parseHoroscopeRequest(JSON.parse(JSON.stringify(horoscopeBody(dayHoroscope({ sunSign: "leo" }, DATE, TZ), DATE, TZ, "en"))))!;
const claims = horoscopeClaims(parsed, referenceSky(DATE, TZ));
const { system, user } = horoscopePrompt(parsed);
const REQ: JsonRequest = { purpose: "horoscope", system, messages: [{ role: "user", content: user }], schema: HOROSCOPE_SCHEMA, schemaName: "horoscope" };

function fake(script: FakeScript = {}) {
  return vi.fn((req: JsonRequest) => callFake(cfg, modelCaps("fake", cfg.model), req, script));
}
const input = (ledger: LedgerPort, subjectKey: string, o: Partial<MeterInput<unknown>> = {}): MeterInput<unknown> => ({
  ledger, cfg, keys, subjectKey, purpose: "horoscope", mode: "free", requestId: `req-${Math.random().toString(36).slice(2, 12)}-0000`,
  req: REQ, canonical: parsed, versions: "v1", validate: (d) => validateHoroscope(d, claims), cacheScope: "subject", resultTtlSeconds: 7200, ...o,
});
const noSleep = { sleep: async () => undefined };

describe("metered generation", LEDGER_TIMEOUT, () => {
  it("completes a valid reply and replays it for free", async () => {
    const { ledger, exec } = await makeTestLedger();
    const v = visitor();
    const call = fake();
    const first = await meteredGenerate(input(ledger, v, { requestId: "same-request-0001" }), { call, ...noSleep });
    expect(first.kind).toBe("fresh");
    if (first.kind === "fresh") expect(first.meta).toMatchObject({ provider: "fake", model: "simulated", source: "simulated" });
    const spent = (await pool(exec, "ai"))!.spent;
    expect(spent).toBeGreaterThan(0);
    const again = await meteredGenerate(input(ledger, v, { requestId: "same-request-0001" }), { call, ...noSleep });
    expect(again.kind).toBe("replayed");
    // a new id with the same input is served from the saved result too
    expect((await meteredGenerate(input(ledger, v), { call, ...noSleep })).kind).toBe("replayed");
    expect(call).toHaveBeenCalledTimes(1);
    expect((await pool(exec, "ai"))!.spent).toBe(spent);
    await expectAudit(ledger);
  });

  it("settles failures by billing class", async () => {
    const { ledger, exec } = await makeTestLedger();
    const of = (v: string) => row<{ billing: string; charged: number; bound: number; error_code: string }>(exec, "select billing, charged_micro::int as charged, bound_micro::int as bound, error_code from moona.requests where subject_key = $1", [v]);
    const a = visitor(), b = visitor(), c = visitor();
    const bad = await meteredGenerate(input(ledger, a), { call: fake({ fail: "bad_json" }), ...noSleep });
    expect(bad).toMatchObject({ kind: "failed", error: { code: "bad_output" } });
    expect(await of(a)).toMatchObject({ billing: "known", error_code: "bad_output" });
    expect((await of(a)).charged).toBeGreaterThan(0);

    const timeout = await meteredGenerate(input(ledger, b), { call: fake({ fail: "timeout" }), ...noSleep });
    expect(timeout).toMatchObject({ kind: "failed", error: { code: "timeout" } });
    const t = await of(b);
    expect(t.billing).toBe("unknown");
    expect(t.charged).toBe(t.bound);

    const limited = await meteredGenerate(input(ledger, c), { call: fake({ fail: "rate_limited" }), ...noSleep });
    expect(limited).toMatchObject({ kind: "failed", error: { rateLimited: true } });
    expect(await of(c)).toMatchObject({ billing: "none", charged: 0 });
    expect((await row<{ hits: number }>(exec, "select rl_hits as hits from moona.gate")).hits).toBe(1);
    await expectAudit(ledger);
  });

  it("retries settling through a ledger hiccup, and never loses the reading", async () => {
    const { ledger, exec, clock } = await makeTestLedger();
    let failures = 1;
    const flaky: LedgerPort = { ...ledger, complete: (r) => (failures-- > 0 ? Promise.reject(new LedgerUnavailable("ledger_down")) : ledger.complete(r)) };
    const sleep = vi.fn(async () => undefined);
    const ok = await meteredGenerate(input(flaky, visitor()), { call: fake(), sleep });
    expect(ok.kind).toBe("fresh");
    expect(sleep).toHaveBeenCalledWith(100);
    expect((await row<{ state: string }>(exec, "select state from moona.requests limit 1")).state).toBe("succeeded");

    // down for good: the value still comes back; the reaper charges the bound once the lease ends
    const down: LedgerPort = { ...ledger, complete: () => Promise.reject(new LedgerUnavailable("ledger_down")) };
    const v = visitor();
    const still = await meteredGenerate(input(down, v), { call: fake(), ...noSleep });
    expect(still.kind).toBe("fresh");
    clock.advance(121_000);
    await ledger.reap();
    expect(await row(exec, "select state, billing from moona.requests where subject_key = $1", [v])).toEqual({ state: "expired", billing: "bound" });
    await expectAudit(ledger);
  });

  it("never calls the provider when the ledger can't reserve", async () => {
    const { ledger } = await makeTestLedger();
    const call = fake();
    const down: LedgerPort = { ...ledger, reserve: () => Promise.reject(new LedgerUnavailable("ledger_down")) };
    expect(await meteredGenerate(input(down, visitor()), { call, ...noSleep })).toEqual({ kind: "unavailable" });
    const denied = await makeTestLedger({ clock: makeClock("2027-06-01T00:00:00Z") });
    expect(await meteredGenerate(input(denied.ledger, visitor()), { call, ...noSleep })).toEqual({ kind: "denied", reason: "no_window" });
    expect(call).not.toHaveBeenCalled();
  });

  it("pauses AI when a call costs more than its bound", async () => {
    const { ledger, exec } = await makeTestLedger({ plan: testPlan({ overrunTripMicro: 1 }) });
    const over = await meteredGenerate(input(ledger, visitor()), { call: fake({ usage: "over_bound" }), ...noSleep });
    expect(over.kind).toBe("fresh");
    expect((await pool(exec, "ai"))!.overrun).toBeGreaterThan(0);
    const snap = await ledger.snapshot();
    expect(snap.kind === "sql" && snap.gate.breaker).toBe("tripped");
    expect(await meteredGenerate(input(ledger, visitor()), { call: fake(), ...noSleep })).toEqual({ kind: "denied", reason: "paused" });
    await expectAudit(ledger);
  });

  it("joins an identical request that is still running", async () => {
    const { ledger } = await makeTestLedger();
    const v = visitor();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = vi.fn(async (req: JsonRequest) => { await gate; return callFake(cfg, modelCaps("fake", cfg.model), req, {}); });
    const first = meteredGenerate(input(ledger, v, { requestId: "first-request-0001" }), { call: slow, ...noSleep });
    await new Promise((r) => setTimeout(r, 20));
    expect(await meteredGenerate(input(ledger, v, { requestId: "second-request-001" }), { call: slow, ...noSleep })).toEqual({ kind: "in_progress", retryAfterMs: 2000 });
    expect(await meteredGenerate(input(ledger, v, { requestId: "first-request-0001" }), { call: slow, ...noSleep })).toEqual({ kind: "in_progress", retryAfterMs: 2000 });
    release();
    expect((await first).kind).toBe("fresh");
    expect(slow).toHaveBeenCalledTimes(1);
    await expectAudit(ledger);
  });
});
