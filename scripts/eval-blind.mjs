// Blind comparison of two eval runs (e.g. GPT vs Claude) on the same cases.
//
//   node scripts/eval-blind.mjs <runA.json> <runB.json> [--out eval/results/blind] [--seed 7]
//      -> <out>.html  (self-contained rating sheet: graders see the inputs and two unlabeled outputs)
//      -> <out>-key.json  (which run is A/B per case; keep it away from graders)
//   node scripts/eval-blind.mjs --score <ratings.json> <out>-key.json
//      -> per-model tallies, plus measured speed and cost from the runs
//
// Criteria follow the combined review: facts used correctly, specific (not generic), answers the
// question, respects uncertainty, language and style. Speed and cost are measured, not rated.
import { readFileSync, writeFileSync } from "node:fs";

const CRITERIA = [
  ["facts", "Facts used correctly / 引用正确"],
  ["specific", "Specific, not generic / 具体不空泛"],
  ["answers", "Answers the question / 回应了问题"],
  ["uncertainty", "Respects uncertainty / 尊重不确定性"],
  ["style", "Language & style / 文风自然"],
  ["overall", "Overall preference / 总体偏好"],
];

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const load = (p) => JSON.parse(readFileSync(p, "utf8"));

if (argv[0] === "--score") {
  const ratings = load(argv[1]);
  const key = load(argv[2]);
  const tally = {};
  for (const label of key.labels) tally[label] = Object.fromEntries(CRITERIA.map(([c]) => [c, { win: 0, tie: 0, loss: 0 }]));
  for (const [id, r] of Object.entries(ratings.cases ?? {})) {
    const k = key.cases[id];
    if (!k) continue;
    for (const [c] of CRITERIA) {
      const v = r[c];
      if (!v) continue;
      const winner = v === "A" ? k.A : v === "B" ? k.B : null;
      for (const label of key.labels) {
        if (!winner) tally[label][c].tie++;
        else if (winner === label) tally[label][c].win++;
        else tally[label][c].loss++;
      }
    }
  }
  console.log(`rated cases: ${Object.keys(ratings.cases ?? {}).length} of ${Object.keys(key.cases).length}`);
  for (const label of key.labels) {
    console.log(`\n${label}  (${key.measured[label]})`);
    for (const [c, title] of CRITERIA) {
      const t = tally[label][c];
      console.log(`  ${title.padEnd(40)} win ${t.win}  tie ${t.tie}  loss ${t.loss}`);
    }
  }
  process.exit(0);
}

const [pathA, pathB] = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!pathA || !pathB) {
  console.error("usage: node scripts/eval-blind.mjs <runA.json> <runB.json> [--out eval/results/blind] [--seed 7]");
  process.exit(1);
}
const runs = [load(pathA), load(pathB)];
if (runs[0].evalVersion !== runs[1].evalVersion) throw new Error("runs use different eval versions");
const labels = runs.map((r, i) => r.label || `run${i + 1}`);
if (labels[0] === labels[1]) labels[1] += "-2";
const set = load(new URL("../eval/requests.json", import.meta.url));
const out = opt("out", "eval/results/blind");

// Seeded shuffle so the same seed reproduces the same A/B assignment.
const seed0 = Number(opt("seed", Date.now() % 100000));
let seed = seed0;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const byId = (run) => Object.fromEntries(run.results.map((r) => [r.id, r]));
const [ra, rb] = runs.map(byId);
const key = { labels, seed: seed0, measured: {}, cases: {} };
runs.forEach((run, i) => {
  const s = run.summary;
  // runs saved by the older runner have no modelCases (their modelCalls counted the model cases)
  const of = s.modelCases ?? s.modelCalls;
  const cost = s.costUsd === null || s.costUsd === undefined ? `cost unknown (${s.costAttributed?.cases ?? 0}/${s.costAttributed?.of ?? "?"} cases attributed)` : `$${s.costUsd}`;
  key.measured[labels[i]] = `${run.provider}/${run.model}: ${s.ok}/${of} ok, ${cost}, p50 ${s.latencyMs.p50} ms, p90 ${s.latencyMs.p90} ms${run.provider === "fake" ? " (simulated: pipeline only, not model quality)" : ""}`;
});

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const outputOf = (r) => (r ? (r.code === "ok" ? r.text : `[no output: ${r.code}]`) : "[missing]");
const items = [];
for (const c of set.cases.filter((x) => !x.expectCode)) {
  if (!ra[c.id] && !rb[c.id]) continue;
  const flip = rand() < 0.5;
  const [A, B] = flip ? [rb[c.id], ra[c.id]] : [ra[c.id], rb[c.id]];
  key.cases[c.id] = { A: flip ? labels[1] : labels[0], B: flip ? labels[0] : labels[1] };
  items.push(`
<section class="case" data-id="${esc(c.id)}">
  <h2>${esc(c.id)} · ${esc(c.kind)} · ${esc(c.locale)}</h2>
  <p class="covers">${esc(c.covers.join(" · "))}</p>
  <details><summary>Inputs / 输入</summary><pre>${esc(c.context)}</pre></details>
  <div class="pair">
    <div class="out"><h3>A</h3><pre>${esc(outputOf(A))}</pre></div>
    <div class="out"><h3>B</h3><pre>${esc(outputOf(B))}</pre></div>
  </div>
  <table>${CRITERIA.map(([k, title]) => `
    <tr><th>${esc(title)}</th>${["A", "tie", "B"].map((v) => `<td><label><input type="radio" name="${esc(c.id)}.${k}" value="${v}"> ${v === "tie" ? "Tie / 相当" : v}</label></td>`).join("")}</tr>`).join("")}
  </table>
  <textarea placeholder="Notes (optional) / 备注" data-note="${esc(c.id)}"></textarea>
</section>`);
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MOONA blind review</title>
<style>
:root { --bg:#fff; --fg:#1d1b26; --muted:#6b6880; --line:#e3e1ea; --panel:#f7f6fb; }
@media (prefers-color-scheme: dark) { :root { --bg:#14121b; --fg:#ece9f5; --muted:#a29fb5; --line:#2f2c3b; --panel:#1d1a27; } }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 system-ui, sans-serif; }
main { max-width:1100px; margin:0 auto; padding:24px 16px 80px; }
.case { border-top:1px solid var(--line); padding:20px 0; }
.covers { color:var(--muted); margin:4px 0 8px; }
.pair { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:12px 0; }
@media (max-width:720px) { .pair { grid-template-columns:1fr; } }
.out { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px 12px; min-width:0; }
pre { white-space:pre-wrap; word-break:break-word; font:inherit; margin:0; }
table { border-collapse:collapse; width:100%; }
th { text-align:left; font-weight:500; padding:4px 8px 4px 0; }
td { padding:4px 8px; white-space:nowrap; }
textarea { width:100%; box-sizing:border-box; min-height:48px; margin-top:8px; background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:6px; font:inherit; }
.bar { position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line); padding:10px 0; display:flex; gap:12px; align-items:center; flex-wrap:wrap; z-index:1; }
button { font:inherit; padding:6px 14px; border-radius:6px; border:1px solid var(--line); background:var(--panel); color:var(--fg); cursor:pointer; }
</style></head>
<body><main>
<h1>MOONA blind review · ${esc(set.version)}</h1>
<p>Two models answered the same ${items.length} cases. For each case, compare A and B on every row. A and B are shuffled per case. Don't look up which is which until you're done. Ratings autosave in this browser; export them when finished.</p>
<div class="bar"><button id="export">Export ratings (JSON)</button><span id="progress"></span></div>
${items.join("\n")}
</main>
<script>
const KEY = "moona-blind-${esc(set.version)}-${key.seed ?? "x"}";
const inputs = () => [...document.querySelectorAll("input[type=radio]")];
function collect() {
  const cases = {};
  for (const i of inputs()) if (i.checked) { const [id, k] = i.name.split("."); (cases[id] ??= {})[k] = i.value; }
  for (const t of document.querySelectorAll("textarea[data-note]")) if (t.value.trim()) (cases[t.dataset.note] ??= {}).note = t.value.trim();
  return { evalVersion: ${JSON.stringify(set.version)}, savedAt: new Date().toISOString(), cases };
}
function progress() {
  const done = [...document.querySelectorAll(".case")].filter((s) => s.querySelector("input[name$='.overall']:checked")).length;
  document.getElementById("progress").textContent = done + " / " + document.querySelectorAll(".case").length + " cases rated (overall)";
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(collect())); } catch {} progress(); }
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || "null");
  if (saved) for (const [id, r] of Object.entries(saved.cases)) {
    for (const [k, v] of Object.entries(r)) {
      if (k === "note") { const t = document.querySelector('textarea[data-note="' + CSS.escape(id) + '"]'); if (t) t.value = v; }
      else { const i = document.querySelector('input[name="' + CSS.escape(id + "." + k) + '"][value="' + v + '"]'); if (i) i.checked = true; }
    }
  }
} catch {}
document.addEventListener("change", save);
document.addEventListener("input", (e) => { if (e.target.matches("textarea")) save(); });
document.getElementById("export").onclick = () => {
  const blob = new Blob([JSON.stringify(collect(), null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "moona-blind-ratings.json"; a.click(); URL.revokeObjectURL(a.href);
};
progress();
</script>
</body></html>
`;
writeFileSync(`${out}.html`, html);
writeFileSync(`${out}-key.json`, JSON.stringify(key, null, 2) + "\n");
console.log(`wrote ${out}.html (${items.length} cases) and ${out}-key.json (keep the key away from graders)`);
