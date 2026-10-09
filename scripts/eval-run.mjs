// Runs the fixed evaluation set (eval/requests.json) against a running MOONA server, through the same
// AI routes the browser uses (validation, budget ledger, provider adapter). One provider/model per run:
// start the server with the provider you want to test, run this, then switch and run again.
//
//   node scripts/eval-run.mjs --base http://localhost:3000 [--access CODE] [--label name] [--only N1,T2] [--out file] --yes
//
// Without --yes it only prints what it would do (no model calls). Cost per case is the change in the
// server's budget ledger (an estimate from the configured prices, not the provider's invoice).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const base = String(args.base ?? "http://localhost:3000").replace(/\/$/, "");
const headers = { "Content-Type": "application/json", ...(args.access ? { Cookie: `moona-ai-access=${encodeURIComponent(args.access)}` } : {}) };
const set = JSON.parse(readFileSync(new URL("../eval/requests.json", import.meta.url), "utf8"));
const only = args.only ? new Set(String(args.only).split(",")) : null;
const cases = set.cases.filter((c) => !only || only.has(c.id));

async function status() {
  const res = await fetch(`${base}/api/ai/status`, { headers });
  return res.json();
}

/** All model-written text in a response, for checks and for graders. */
function outputText(kind, body) {
  if (!body || body.code) return "";
  if (kind === "natal") return [body.overview, ...(body.themes ?? []).map((t) => t.text)].join("\n\n");
  if (kind === "tarot") return [...(body.cards ?? []).map((c) => c.insight), body.synthesis, body.action, body.reflection].join("\n\n");
  if (kind === "chat") return [body.reply, body.remember ? `[remember] ${body.remember.text} ← "${body.remember.quote}"` : ""].filter(Boolean).join("\n\n");
  if (kind === "horoscope") return [body.overall, body.love, body.work].join("\n\n");
  return "";
}

const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);

const s0 = await status();
if (!s0.available) {
  console.error(`AI is not available at ${base}: ${s0.reason ?? "unknown"} (unconfigured = no key/model; locked = pass --access; budget = cap reached).`);
  process.exit(1);
}
const modelCalls = cases.filter((c) => !c.expectCode).length;
console.log(`${set.version}: ${cases.length} cases, ${modelCalls} model calls → ${s0.provider} / ${s0.model} at ${base}`);
console.log(`budget so far: $${s0.budget.usdTotal.toFixed(4)} of $${s0.budget.limits.maxUsdTotal} total; today $${s0.budget.usdToday.toFixed(4)} of $${s0.budget.limits.maxUsdPerDay}, ${s0.budget.callsToday}/${s0.budget.limits.maxCallsPerDay} calls`);
if (!args.yes) {
  console.log("Dry run: no requests sent. Re-run with --yes to make these calls (they cost money on a real provider).");
  process.exit(0);
}

const startedAt = new Date().toISOString();
const results = [];
for (const c of cases) {
  const before = (await status()).budget?.usdTotal ?? 0;
  const t0 = performance.now();
  let httpStatus = 0, body = null, error = null;
  try {
    const res = await fetch(`${base}${c.endpoint}`, { method: "POST", headers, body: JSON.stringify(c.body) });
    httpStatus = res.status;
    body = await res.json().catch(() => null);
  } catch (e) {
    error = String(e?.message ?? e);
  }
  const latencyMs = Math.round(performance.now() - t0);
  const after = (await status()).budget?.usdTotal ?? before;
  const text = outputText(c.kind, body);
  const checks = [
    ...(c.expectCode ? [{ name: `handled as ${c.expectCode}, no model call`, pass: body?.code === c.expectCode && after === before }] : []),
    ...(c.must ?? []).map((k) => ({ name: k.name, pass: new RegExp(k.pattern, k.flags ?? "").test(text) })),
    ...(c.mustNot ?? []).map((k) => ({ name: k.name, pass: !new RegExp(k.pattern, k.flags ?? "").test(text) })),
  ];
  const code = error ? "network" : body?.code ?? (httpStatus === 200 ? "ok" : `http_${httpStatus}`);
  results.push({ id: c.id, kind: c.kind, locale: c.locale, covers: c.covers, httpStatus, code, latencyMs, costUsd: +(after - before).toFixed(6), meta: body?.meta ?? null, text, checks, response: body, error });
  const flag = checks.some((k) => !k.pass) ? " ⚑ " + checks.filter((k) => !k.pass).map((k) => k.name).join("; ") : "";
  console.log(`${c.id.padEnd(3)} ${c.kind.padEnd(9)} ${c.locale} ${code.padEnd(10)} ${String(latencyMs).padStart(6)} ms  $${(after - before).toFixed(4)}${flag}`);
  if (httpStatus === 429 || body?.code === "budget") {
    console.error("Stopped: rate limit or budget cap reached. Results so far are saved.");
    break;
  }
}

const model = results.filter((r) => r.kind !== "crisis");
const ok = model.filter((r) => r.code === "ok");
const lat = ok.map((r) => r.latencyMs);
const summary = {
  cases: results.length,
  modelCalls: model.length,
  ok: ok.length,
  byCode: Object.fromEntries([...new Set(results.map((r) => r.code))].map((k) => [k, results.filter((r) => r.code === k).length])),
  flagged: results.filter((r) => r.checks.some((k) => !k.pass)).map((r) => r.id),
  costUsd: +results.reduce((s, r) => s + r.costUsd, 0).toFixed(6),
  latencyMs: { p50: pct(lat, 50), p90: pct(lat, 90), max: lat.length ? Math.max(...lat) : null },
};
const label = String(args.label ?? `${s0.provider}-${s0.model}`).replace(/[^\w.-]+/g, "_");
const out = String(args.out ?? join("eval", "results", `${startedAt.slice(0, 19).replace(/[:T]/g, "-")}-${label}.json`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ evalVersion: set.version, label, base, provider: s0.provider, model: s0.model, startedAt, finishedAt: new Date().toISOString(), summary, results }, null, 2) + "\n");
console.log(`\n${summary.ok}/${summary.modelCalls} model calls ok · codes ${JSON.stringify(summary.byCode)} · flagged ${summary.flagged.join(",") || "none"} · $${summary.costUsd} · p50 ${summary.latencyMs.p50} ms, p90 ${summary.latencyMs.p90} ms`);
console.log(`saved ${out}`);
