// Prints the budget plan in force, entirely offline (spec §12): request bounds per purpose, what one
// pack must set aside, how many packs fit, the fee holds, whether Demo Day covers 1000 typical calls,
// and validatePlan's errors and warnings. Never prints keys. Exit code 1 when the plan has errors.
//   npm run budget:plan            (uses the environment; MOONA_PLAN=event-2026-10-28 for the event)
import { aiConfig } from "@/lib/ai/config";
import { PURPOSES } from "@/lib/ai/types";
import { resolvePlan, typicalCallMicro, validatePlan } from "@/lib/ledger/plans";

const usd = (micro: number) => `$${(micro / 1e6).toFixed(micro < 10_000 ? 4 : 2)}`;
const cfg = aiConfig();
const r = resolvePlan(process.env, cfg);
const { plan, product } = r;
const typical = typicalCallMicro(cfg);

console.log(`Plan ${plan.id} (hash ${r.hash}); model ${cfg.provider}/${cfg.model}${cfg.provider === "fake" ? ` priced as ${cfg.fakePriceAs}` : ""}`);
console.log(`Cash $${plan.cashTotalUsd} = AI $${plan.aiUsd} + hosting $${plan.hostingUsd} + reserve $${plan.reserveUsd}; pack pool $${plan.packPoolUsd} (slack $${plan.packSlackUsd})`);
console.log("\nLargest request per purpose (the bound reserved before each call; en and zh, every shape):");
for (const p of PURPOSES) console.log(`  ${p.padEnd(10)} ${usd(r.bounds[p]).padStart(8)}   output cap ${cfg.maxOutput[p]} tokens`);
console.log(`  follow-up  ${usd(r.followupBound).padStart(8)}`);
console.log(`Typical call (3.8k in / 860 out): ${usd(typical)}`);

console.log("\nWindows:");
for (const w of plan.windows) {
  const calls = Math.floor((w.capUsd * 1e6) / typical);
  console.log(`  ${w.id.padEnd(12)} ${w.startsAt} → ${w.endsAt}  $${w.capUsd}${w.slice ? ` (${w.slice.seconds === 3600 ? "hourly" : "daily"} $${w.slice.capUsd})` : ""}, call cap ${w.callsCap ?? "none"}, ≈${calls} typical calls`);
}

const fits = Math.max(0, Math.floor((plan.packPoolUsd * 1e6 - plan.packSlackUsd * 1e6) / product.allocMicro));
console.log(`\nPack: ${product.readings} readings × (1 + ${product.followupsPerReading} follow-ups), $${(product.amountCents / 100).toFixed(2)} ${product.currency}`);
console.log(`  sets aside ${usd(product.allocMicro)} of AI; fee hold ${usd(product.feeHoldMicro)}; ${fits} pack(s) fit the pool; max sold test ${product.maxSoldTest} / live ${product.maxSoldLive}`);
if (r.priorSpendMicro) console.log(`Prior spend to record: ${usd(r.priorSpendMicro)} (ledger-admin sync-plan)`);

const v = validatePlan(r, cfg, { paymentsOn: (process.env.PAYMENTS_MODE ?? "off") !== "off" });
console.log(`\nvalidatePlan: ${v.errors.length} error(s), ${v.warnings.length} warning(s)`);
for (const e of v.errors) console.log(`  ERROR   ${e}`);
for (const w of v.warnings) console.log(`  warning ${w}`);
process.exit(v.errors.length ? 1 : 0);
