// Budget plans (spec §7.2, budget plan doc §1): the $100 cash total split into AI, hosting and a
// reserve; AI split into time windows (testing / Demo Day / after) with hourly or daily slices, call
// caps and per-visitor free quotas; and an optional pack pool for paid readings, $0 by default so
// sales stay closed. Cost caps and call caps are independent: whichever is reached first denies.
import "server-only";
import { createHash } from "node:crypto";
import type { AiConfig, EnvLike } from "@/lib/ai/config";
import { followupBoundMicro, worstCaseBoundMicro } from "@/lib/ai/worst-case";
import { priceFor } from "@/lib/ai/pricing";
import { PURPOSES, type Purpose } from "@/lib/ai/types";
import { canonicalJson } from "./hash";
import type { SyncPlanPayload } from "./port";

export interface WindowPlan {
  id: string;
  startsAt: string;
  endsAt: string;
  capUsd: number;
  callsCap: number | null;
  slice: { capUsd: number; seconds: 3600 | 86400 } | null;
  mintCap: number | null;
  quotas: Record<Purpose, { perSubject: number; failedCap: number }>;
}

export interface BudgetPlan {
  id: "dev" | "event-2026-10-28";
  cashTotalUsd: number;
  aiUsd: number;
  hostingUsd: number;
  reserveUsd: number;
  packPoolUsd: number;
  packSlackUsd: number;
  windows: WindowPlan[];
  inflightCap: number;
  subjectInflightCap: number;
  leaseSeconds: number;
  overrunTripUsd: number;
  unknownTrip: number;
  unknownCooldownS: number;
  rlTrip: number;
  rlWindowS: number;
  rlCooldownS: number;
  mintNetLimit: number;
  mintNetWindowS: number;
  warnAt: [number, number, number];
}

export interface ProductPlan {
  id: "tarot5";
  amountCents: number;
  currency: string;
  readings: number;
  followupsPerReading: number;
  attemptsPerUnit: number;
  allocMicro: number;
  feeHoldMicro: number;
  maxSoldTest: number;
  maxSoldLive: number;
  checkoutTtlS: number;
}

export interface ResolvedPlan {
  plan: BudgetPlan;
  product: ProductPlan;
  hash: string;
  sync: SyncPlanPayload;
  bounds: Record<Purpose, number>;
  followupBound: number;
  priorSpendMicro: number;
}

const q = (tarot: [number, number], chat: [number, number], talk: [number, number], natal: [number, number], horoscope: [number, number]): WindowPlan["quotas"] => ({
  tarot: { perSubject: tarot[0], failedCap: tarot[1] }, chat: { perSubject: chat[0], failedCap: chat[1] }, talk: { perSubject: talk[0], failedCap: talk[1] },
  natal: { perSubject: natal[0], failedCap: natal[1] }, horoscope: { perSubject: horoscope[0], failedCap: horoscope[1] },
});

const OPERATING = {
  inflightCap: 24, subjectInflightCap: 2, leaseSeconds: 120, overrunTripUsd: 0.5, unknownTrip: 5, unknownCooldownS: 60,
  rlTrip: 5, rlWindowS: 60, rlCooldownS: 20, mintNetLimit: 400, mintNetWindowS: 600, warnAt: [0.5, 0.8, 0.95] as [number, number, number],
};

export const PLANS: Readonly<Record<BudgetPlan["id"], BudgetPlan>> = {
  dev: {
    id: "dev", cashTotalUsd: 100, aiUsd: 25, hostingUsd: 0, reserveUsd: 30, packPoolUsd: 5, packSlackUsd: 1, ...OPERATING,
    windows: [{ id: "win:dev", startsAt: "2026-01-01T00:00:00Z", endsAt: "2027-01-01T00:00:00Z", capUsd: 20, callsCap: null, slice: { capUsd: 5, seconds: 86400 }, mintCap: null, quotas: q([100, 50], [100, 50], [100, 50], [100, 50], [100, 50]) }],
  },
  "event-2026-10-28": {
    id: "event-2026-10-28", cashTotalUsd: 100, aiUsd: 50, hostingUsd: 20, reserveUsd: 30, packPoolUsd: 0, packSlackUsd: 1, ...OPERATING,
    windows: [
      { id: "win:testing", startsAt: "2026-10-09T00:00:00-04:00", endsAt: "2026-10-28T00:00:00-04:00", capUsd: 10, callsCap: 3000, slice: { capUsd: 3, seconds: 86400 }, mintCap: 300, quotas: q([30, 20], [60, 20], [60, 20], [15, 10], [30, 10]) },
      { id: "win:demo", startsAt: "2026-10-28T00:00:00-04:00", endsAt: "2026-10-29T06:00:00-04:00", capUsd: 35, callsCap: 2500, slice: { capUsd: 15, seconds: 3600 }, mintCap: 3000, quotas: q([2, 3], [4, 3], [4, 3], [1, 2], [3, 2]) },
      { id: "win:after", startsAt: "2026-10-29T06:00:00-04:00", endsAt: "2026-11-28T00:00:00-05:00", capUsd: 5, callsCap: 800, slice: { capUsd: 1, seconds: 86400 }, mintCap: 1000, quotas: q([1, 2], [2, 2], [2, 2], [1, 1], [1, 1]) },
    ],
  },
};

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const usd = (x: number) => Math.round(x * 1e6);

/** The plan in force: MOONA_PLAN plus environment overrides, with pack allocation from the worst-case bounds. */
export function resolvePlan(env: EnvLike, cfg: AiConfig): ResolvedPlan {
  const base = PLANS[(env.MOONA_PLAN as BudgetPlan["id"]) in PLANS ? (env.MOONA_PLAN as BudgetPlan["id"]) : "dev"];
  const plan: BudgetPlan = structuredClone(base) as BudgetPlan;
  plan.aiUsd = num(env.AI_TOTAL_USD, plan.aiUsd);
  for (const part of (env.AI_WINDOW_USD ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, v] = part.split(":");
    const w = plan.windows.find((x) => x.id === `win:${name}`);
    if (w && Number.isFinite(Number(v))) w.capUsd = Number(v);
  }
  const demo = plan.windows.find((w) => w.id === "win:demo");
  if (demo && env.AI_DEMO_HOURLY_USD !== undefined) {
    const h = num(env.AI_DEMO_HOURLY_USD, 15);
    demo.slice = h > 0 ? { capUsd: h, seconds: 3600 } : null;
  }
  // Free readings per visitor and purpose, for every window (a team decision; also used by rehearsals):
  // AI_FREE_QUOTA=tarot:2,chat:4,talk:4,natal:1,horoscope:3
  for (const part of (env.AI_FREE_QUOTA ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [purpose, v] = part.split(":");
    const n = Number(v);
    if ((PURPOSES as readonly string[]).includes(purpose) && Number.isInteger(n) && n >= 0) for (const w of plan.windows) w.quotas[purpose as Purpose].perSubject = n;
  }
  plan.packPoolUsd = num(env.PACK_POOL_USD, plan.packPoolUsd);
  plan.packSlackUsd = num(env.PACK_SLACK_USD, plan.packSlackUsd);
  plan.cashTotalUsd = num(env.BUDGET_CASH_TOTAL_USD, plan.cashTotalUsd);
  plan.hostingUsd = num(env.BUDGET_HOSTING_USD, plan.hostingUsd);
  plan.reserveUsd = num(env.BUDGET_RESERVE_USD, plan.reserveUsd);
  plan.inflightCap = num(env.AI_INFLIGHT_MAX, plan.inflightCap);
  plan.subjectInflightCap = num(env.AI_SUBJECT_INFLIGHT_MAX, plan.subjectInflightCap);
  plan.leaseSeconds = num(env.AI_LEASE_SECONDS, plan.leaseSeconds);
  plan.overrunTripUsd = num(env.AI_OVERRUN_TRIP_USD, plan.overrunTripUsd);
  plan.mintNetLimit = num(env.AI_MINT_NET_LIMIT, plan.mintNetLimit);
  plan.mintNetWindowS = num(env.AI_MINT_NET_WINDOW_S, plan.mintNetWindowS);
  plan.unknownTrip = num(env.AI_UNKNOWN_TRIP, plan.unknownTrip);
  plan.unknownCooldownS = num(env.AI_UNKNOWN_COOLDOWN_S, plan.unknownCooldownS);
  plan.rlTrip = num(env.AI_RL_TRIP, plan.rlTrip);
  plan.rlWindowS = num(env.AI_RL_WINDOW_S, plan.rlWindowS);
  plan.rlCooldownS = num(env.AI_RL_COOLDOWN_S, plan.rlCooldownS);
  const warn = (env.AI_WARN_AT ?? "").split(",").map(Number);
  if (warn.length === 3 && warn.every((x) => Number.isFinite(x))) plan.warnAt = warn as [number, number, number];

  const bounds = Object.fromEntries(PURPOSES.map((p) => [p, worstCaseBoundMicro(p, cfg)])) as Record<Purpose, number>;
  const followupBound = followupBoundMicro(cfg);
  const readings = num(env.STORE_PACK_READINGS, 5), followups = num(env.STORE_PACK_FOLLOWUPS, 2), attempts = Math.max(1, num(env.STORE_ATTEMPTS_PER_UNIT, 1));
  const amountCents = num(env.STORE_PACK_PRICE_CENTS, 500);
  const feeCents = Math.ceil((amountCents * num(env.STORE_FEE_BP, 440)) / 10000 + num(env.STORE_FEE_FIXED_CENTS, 30));
  const product: ProductPlan = {
    id: "tarot5", amountCents, currency: (env.STORE_PACK_CURRENCY ?? "usd").toLowerCase(), readings, followupsPerReading: followups, attemptsPerUnit: attempts,
    allocMicro: readings * (bounds.tarot + followups * followupBound) * attempts, feeHoldMicro: feeCents * 10_000,
    maxSoldTest: num(env.STORE_MAX_PACKS_TEST, 3), maxSoldLive: num(env.STORE_MAX_PACKS_LIVE, 10), checkoutTtlS: num(env.STORE_CHECKOUT_TTL_S, 1860),
  };

  const pools: Record<string, unknown>[] = [
    { id: "ai", kind: "ai", cap_micro: usd(plan.aiUsd) },
    { id: "packs", kind: "packs", cap_micro: usd(plan.packPoolUsd) },
    { id: "hosting", kind: "hosting", cap_micro: usd(plan.hostingUsd) },
    { id: "reserve", kind: "reserve", cap_micro: usd(plan.reserveUsd) },
    ...plan.windows.map((w) => ({
      id: w.id, kind: "window", cap_micro: usd(w.capUsd), calls_cap: w.callsCap, slice_cap_micro: w.slice ? usd(w.slice.capUsd) : null, slice_seconds: w.slice?.seconds ?? null,
      mint_cap: w.mintCap, starts_at: new Date(w.startsAt).toISOString(), ends_at: new Date(w.endsAt).toISOString(),
    })),
  ];
  const quotas = plan.windows.flatMap((w) => PURPOSES.map((p) => ({ window_id: w.id, purpose: p, per_subject: w.quotas[p].perSubject, failed_cap: w.quotas[p].failedCap })));
  const products = [{ id: product.id, active: true, amount_cents: product.amountCents, currency: product.currency, readings: product.readings, followups_per_reading: product.followupsPerReading, alloc_micro: product.allocMicro, fee_hold_micro: product.feeHoldMicro, max_sold_test: product.maxSoldTest, max_sold_live: product.maxSoldLive }];
  const planRow: Record<string, unknown> = {
    plan_id: plan.id, cash_total_micro: usd(plan.cashTotalUsd), overrun_trip_micro: usd(plan.overrunTripUsd), inflight_cap: plan.inflightCap, subject_inflight_cap: plan.subjectInflightCap,
    lease_seconds: plan.leaseSeconds, unknown_trip: plan.unknownTrip, unknown_cooldown_s: plan.unknownCooldownS, rl_trip: plan.rlTrip, rl_window_s: plan.rlWindowS, rl_cooldown_s: plan.rlCooldownS,
    mint_net_limit: plan.mintNetLimit, mint_net_window_s: plan.mintNetWindowS, checkout_ttl_s: product.checkoutTtlS, pack_slack_micro: usd(plan.packSlackUsd),
  };
  const hash = createHash("sha256").update(canonicalJson({ plan: planRow, pools, quotas, products })).digest("hex").slice(0, 16);
  planRow.plan_hash = hash;
  return { plan, product, hash, sync: { plan: planRow, pools, quotas, products }, bounds, followupBound, priorSpendMicro: usd(num(env.AI_PRIOR_SPEND_USD, 0)) };
}

/** A typical call (3.8k input, 860 output tokens) at the configured model's price. */
export function typicalCallMicro(cfg: AiConfig): number {
  const p = priceFor(cfg, cfg.model).price;
  return Math.ceil((3800 * p.inN + 860 * p.outN) / 1000);
}

/** Errors stop a plan from being synced; warnings are printed by scripts/budget-plan.ts and shown to operators. */
export function validatePlan(r: ResolvedPlan, cfg: AiConfig, o: { routeMaxDurationS?: number; providerTimeoutMaxS?: number; paymentsOn?: boolean } = {}): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  const { plan, product } = r;
  const maxDuration = o.routeMaxDurationS ?? 60, providerTimeout = o.providerTimeoutMaxS ?? 40;
  const ws = [...plan.windows].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  for (let i = 1; i < ws.length; i++) if (Date.parse(ws[i].startsAt) < Date.parse(ws[i - 1].endsAt)) errors.push(`windows overlap: ${ws[i - 1].id} / ${ws[i].id}`);
  for (const w of plan.windows) {
    if (Date.parse(w.startsAt) >= Date.parse(w.endsAt)) errors.push(`${w.id} ends before it starts`);
    for (const p of PURPOSES) if (!w.quotas[p]) errors.push(`${w.id} has no quota for ${p}`);
  }
  const windowsUsd = plan.windows.reduce((s, w) => s + w.capUsd, 0);
  if (usd(windowsUsd) + usd(plan.packPoolUsd) > usd(plan.aiUsd)) errors.push(`windows ($${windowsUsd}) + pack pool ($${plan.packPoolUsd}) exceed AI ($${plan.aiUsd})`);
  if (usd(plan.aiUsd) + usd(plan.hostingUsd) + usd(plan.reserveUsd) > usd(plan.cashTotalUsd)) errors.push(`AI + hosting + reserve exceed the cash total ($${plan.cashTotalUsd})`);
  if (plan.leaseSeconds <= maxDuration) errors.push(`lease (${plan.leaseSeconds}s) must exceed the route maxDuration (${maxDuration}s)`);
  if (maxDuration <= providerTimeout) errors.push(`route maxDuration (${maxDuration}s) must exceed the longest provider timeout (${providerTimeout}s)`);
  const ints = [plan.inflightCap, plan.subjectInflightCap, plan.leaseSeconds, plan.unknownTrip, plan.unknownCooldownS, plan.rlTrip, plan.rlWindowS, plan.rlCooldownS, plan.mintNetLimit, plan.mintNetWindowS, product.readings, product.followupsPerReading, product.maxSoldTest, product.maxSoldLive];
  if (ints.some((x) => !Number.isInteger(x) || x < 0)) errors.push("a count is not a non-negative integer");
  if ([plan.aiUsd, plan.hostingUsd, plan.reserveUsd, plan.packPoolUsd, plan.packSlackUsd, plan.overrunTripUsd, ...plan.windows.map((w) => w.capUsd), ...plan.windows.map((w) => w.slice?.capUsd ?? 0)].some((x) => !Number.isFinite(x) || x < 0)) errors.push("a dollar amount is negative");
  // the database's own ranges (001_schema.sql), so a bad value is named here rather than failing the sync
  const within = (name: string, v: number, lo: number, hi = Number.MAX_SAFE_INTEGER) => { if (!(Number.isInteger(v) && v >= lo && v <= hi)) errors.push(`${name} must be a whole number from ${lo}${hi < Number.MAX_SAFE_INTEGER ? ` to ${hi}` : ""}`); };
  within("lease seconds", plan.leaseSeconds, 30, 900);
  within("checkout time to live", product.checkoutTtlS, 1860, 86000);
  within("in-flight cap", plan.inflightCap, 1);
  within("per-visitor in-flight cap", plan.subjectInflightCap, 1);
  within("unknown-billing trip", plan.unknownTrip, 1);
  within("rate-limit trip", plan.rlTrip, 1);
  within("rate-limit window", plan.rlWindowS, 1);
  within("mint limit", plan.mintNetLimit, 1);
  within("mint window", plan.mintNetWindowS, 1);
  within("pack price in cents", product.amountCents, 1);
  within("readings per pack", product.readings, 1);
  within("attempts per unit", product.attemptsPerUnit, 1);
  if (!(product.feeHoldMicro >= 0)) errors.push("the fee hold is negative");
  if (!/^[a-z]{3}$/.test(product.currency)) errors.push("the currency must be a 3-letter code");
  for (const w of plan.windows) for (const p of PURPOSES) {
    const q = w.quotas[p];
    if (q && !(Number.isInteger(q.perSubject) && q.perSubject >= 0 && Number.isInteger(q.failedCap) && q.failedCap >= 1)) errors.push(`${w.id} ${p}: quotas are whole numbers and the failure cap is at least 1`);
  }

  const typical = typicalCallMicro(cfg);
  const demo = plan.windows.find((w) => w.id === "win:demo");
  if (demo) {
    if (demo.callsCap !== null && demo.callsCap < 1000) warnings.push(`Demo Day call cap ${demo.callsCap} is below 1000`);
    if (usd(demo.capUsd) < 1000 * typical) warnings.push(`Demo Day cap $${demo.capUsd} is below 1000 typical calls ($${((1000 * typical) / 1e6).toFixed(2)})`);
  }
  for (const w of plan.windows) if (w.slice && usd(w.slice.capUsd) < 300 * typical) warnings.push(`${w.id} slice $${w.slice.capUsd} is below 300 typical calls`);
  const fits = Math.floor((usd(plan.packPoolUsd) - usd(plan.packSlackUsd)) / product.allocMicro);
  if (fits < 1 && o.paymentsOn) warnings.push("no pack fits the pack pool: sales stay closed");
  if (product.maxSoldLive * product.feeHoldMicro > usd(plan.reserveUsd)) warnings.push("live packs' fee holds could exceed the reserve");
  return { errors, warnings };
}
