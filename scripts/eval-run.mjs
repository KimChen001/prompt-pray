// Runs the fixed evaluation set (eval/requests.json) against a running MOONA server, through the same
// AI routes the browser uses (validation, shared ledger, provider adapter). One provider/model per run:
// start the server with the provider you want to test, run this, then switch and run again.
//
//   node scripts/eval-run.mjs --base http://localhost:3000 [--label name] [--only N1,T2] [--out file]
//                             [--max-wait 120] [--operator-requests] --yes
//
// Without --yes it only reads the server's status (and, with an operator token, signs this device in
// as an operator): no visitor is made, no AI request is sent, no quota is used. Secrets come from the
// environment and are never printed:
//   MOONA_EVAL_ACCESS (or AI_ACCESS_CODE)   the venue code, when the server has one
//   MOONA_EVAL_OPS_TOKEN (or OPS_TOKEN)     an operator token: the run can then read spending and
//                                           report each case's cost; without one, cost is unknown
// --access CODE still works but shows the code in your shell history.
// --operator-requests sends the AI requests from the operator device too, so they follow the
// server's operator rule (AI_OPERATOR_QUOTA_EXEMPT); by default they come from an ordinary visitor
// and its free quota applies. See eval/README.md.
// Exit codes: 0 done (or dry run), 1 the server or its status can't be used, or the result file can't
// be written (checked before any AI request), 2 stopped before any AI request (the visitor check),
// 3 the run broke off (what was done is saved).
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACCESS_COOKIE, CookieJar, DEFAULTS, describeLedger, ledgerView, makeClient, prepareVisitor, readStatus, replayCheck, runEval, signInOperator, summarize } from "./eval-lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Never process.exit(): on Windows, Node 24 can abort with a libuv assertion when it exits while
// fetch's connections are closing. Setting the exit code and returning lets them close first.
async function main() {
  const base = String(args.base ?? "http://localhost:3000").replace(/\/$/, "");
  const access = typeof args.access === "string" ? args.access : process.env.MOONA_EVAL_ACCESS || process.env.AI_ACCESS_CODE || "";
  const opsToken = process.env.MOONA_EVAL_OPS_TOKEN || process.env.OPS_TOKEN || "";
  const maxWaitMs = Number(args["max-wait"]) > 0 ? Number(args["max-wait"]) * 1000 : DEFAULTS.maxWaitMs;
  const set = JSON.parse(readFileSync(new URL("../eval/requests.json", import.meta.url), "utf8"));
  const only = args.only ? new Set(String(args.only).split(",")) : null;
  const cases = set.cases.filter((c) => !only || only.has(c.id));
  if (!cases.length) return stop(`no cases match --only ${args.only}`, 1);

  // Two cookie jars: the operator's (status reads) and the visitor's (AI requests), so operator rules
  // never apply to the AI requests unless asked for.
  const opsJar = new CookieJar();
  const visitorJar = args["operator-requests"] ? opsJar : new CookieJar();
  for (const jar of new Set([opsJar, visitorJar])) if (access) jar.set(ACCESS_COOKIE, encodeURIComponent(access));
  const opsClient = makeClient({ base, jar: opsJar });
  const aiClient = makeClient({ base, jar: visitorJar });

  let signedIn = { operator: false, reason: "no operator token configured" };
  try {
    if (opsToken) signedIn = await signInOperator(opsClient, opsToken);
  } catch (e) {
    signedIn = { operator: false, reason: String(e?.message ?? e) };
  }
  let s0;
  try {
    s0 = await readStatus(opsClient);
  } catch (e) {
    return stop(`Could not read ${base}/api/ai/status: ${e?.message ?? e}`, 1);
  }
  if (!s0.available) return stop(`AI is not available at ${base}: ${s0.reason ?? "unknown"} (unconfigured = no key/model; locked = set MOONA_EVAL_ACCESS; ledger = no shared ledger; budget = a cap is reached or paused).`, 1);
  const view = signedIn.operator ? ledgerView(s0) : null;
  const modelCases = cases.filter((c) => !c.expectCode).length;
  console.log(`${set.version}: ${cases.length} cases (${modelCases} for the model, ${cases.length - modelCases} answered before any model call) → ${s0.provider} / ${s0.model} at ${base}`);
  if (s0.provider === "fake") console.log("fake provider: simulated replies, no model is called. This proves the pipeline only, never model quality.");
  console.log(`operator device: ${signedIn.operator ? "yes" : `no (${signedIn.reason})`}`);
  console.log(describeLedger(view));
  const replays = view?.kind === "sql";
  console.log(replays
    ? "replay: on (SQL ledger): a lost response is retried once with the same request id, which the server replays or joins"
    : `replay: ${view?.kind === "file" ? "off (the legacy file ledger has no replay): nothing is sent twice" : "unknown (not an operator device)"}: a lost response is recorded, never re-sent`);
  const asOperator = !!args["operator-requests"] && signedIn.operator;
  if (args["operator-requests"] && !signedIn.operator) console.log("--operator-requests: the operator sign-in failed, so the AI requests go from an ordinary visitor");
  if (!args.yes) {
    console.log("Dry run: no AI request was sent and no visitor was made. Re-run with --yes to send the cases (on a real provider they cost money).");
    return 0;
  }

  // the result file must be writable before any AI request (it is saved after every case); it is
  // opened without being emptied, and a file made only for this check is removed if the run stops here
  const runId = randomBytes(9).toString("base64url");
  const startedAt = new Date().toISOString();
  const label = String(args.label ?? `${s0.provider}-${s0.model}`).replace(/[^\w.-]+/g, "_");
  const out = String(args.out ?? join("eval", "results", `${startedAt.slice(0, 19).replace(/[:T]/g, "-")}-${label}.json`));
  const header = { evalVersion: set.version, label, base, provider: s0.provider, model: s0.model, runId, operator: signedIn.operator, operatorRequests: asOperator, ledger: view?.kind ?? null, replay: replays, startedAt };
  const save = (results, extra = {}) => writeFileSync(out, JSON.stringify({ ...header, ...extra, summary: summarize(results), results }, null, 2) + "\n");
  const existed = existsSync(out);
  try {
    mkdirSync(dirname(out), { recursive: true });
    if (existed && statSync(out).isDirectory()) throw new Error("it is a directory");
    closeSync(openSync(out, "a"));
  } catch (e) {
    return stop(`Can't write the result file ${out}: ${e?.message ?? e}. No AI request was sent.`, 1);
  }
  const unmake = () => {
    try {
      if (!existed) rmSync(out);
    } catch {
      // nothing to tidy
    }
  };

  const visitor = await prepareVisitor(aiClient);
  if (!visitor.ok) {
    unmake();
    return stop(visitor.reason === "cookie_dropped"
      ? "Stopped before any AI request: the server's visitor cookie did not stick, so every request would run as a new visitor."
      : `Stopped before any AI request: the visitor check failed (${visitor.reason}).`, 2);
  }
  console.log(`visitor: ${visitor.visitor}${asOperator ? " (operator device: the server's operator quota rule applies)" : " (an ordinary visitor: its free quota applies)"}`);

  const measure = signedIn.operator ? async () => ledgerView(await readStatus(opsClient)) : null;
  const money = (r) => (r.costUsd === null ? "      ?" : `$${r.costUsd.toFixed(4)}`);
  const opts = { measure, networkRetries: replays ? 1 : 0, resend: view?.kind !== "file", maxWaitMs, sleep };

  let results = [];
  try {
    results = await runEval({
      client: aiClient, cases, runId, ...opts,
      onResult: (all, r) => {
        results = all;
        save(all); // saved after every case, so an interrupted run keeps what it did
        const flag = r.checks.some((k) => !k.pass) ? " ⚑ " + r.checks.filter((k) => !k.pass).map((k) => k.name).join("; ") : "";
        const tries = r.attempts > 1 ? ` (${r.attempts} attempts${r.lostResponses ? `, ${r.lostResponses} lost` : ""}${r.waits ? `, ${r.waits} waits` : ""})` : "";
        console.log(`${r.id.padEnd(3)} ${r.kind.padEnd(9)} ${r.locale} ${r.outcome.padEnd(9)} ${r.code.padEnd(14)} ${String(r.latencyMs ?? "-").padStart(6)} ms ${money(r)}${tries}${r.reason ? `  ${r.reason}` : ""}${flag}`);
      },
    });
  } catch (e) {
    let saved = true;
    try {
      save(results, { finishedAt: new Date().toISOString(), brokeOff: String(e?.message ?? e) });
    } catch {
      saved = false;
    }
    const done = results.map((r) => `${r.id} ${r.outcome}`).join(", ") || "none";
    return stop(`The run broke off after ${results.length} cases (${done}): ${e?.message ?? e}. ${saved ? `What was done is saved in ${out}.` : "The result file could not be written."}`, 3);
  }
  let replay;
  try {
    replay = replays ? await replayCheck(aiClient, results, cases, opts) : { ran: false, reason: "needs the SQL ledger, seen from an operator device" };
  } catch (e) {
    replay = { ran: false, reason: `it broke off: ${e?.message ?? e}` };
  }
  save(results, { finishedAt: new Date().toISOString(), replayCheck: replay });
  const s = summarize(results);
  const o = s.outcomes;
  console.log(`\n${s.ok}/${s.modelCases} model cases answered · completed ${o.completed}, replayed ${o.replayed}, handled ${o.handled}, failed ${o.failed}, refused ${o.refused}, lost ${o.lost}, pending ${o.pending}, error ${o.error}, not run ${o.not_run}`);
  console.log(`HTTP attempts ${s.httpAttempts} · model calls: ${s.modelCalls.inferred} inferred from the answers${s.modelCalls.unknown ? ` (+${s.modelCalls.unknown} unknown)` : ""}, ${s.modelCalls.measured ?? "unknown"} measured by the ledger`);
  const part = s.costAttributed.cases ? `, $${s.costAttributed.usd} for those` : "";
  console.log(`cost: ${s.costUsd === null ? `unknown (${s.costAttributed.cases} of ${s.costAttributed.of} sent cases attributed${part})` : `$${s.costUsd}`} · ${s.costNote}`);
  console.log(`latency (cases answered by a model call) p50 ${s.latencyMs.p50} ms, p90 ${s.latencyMs.p90} ms · flagged ${s.flagged.join(",") || "none"}`);
  console.log(`replay check: ${replay.ran ? (replay.pass ? `pass (${replay.caseId} replayed, ${replay.ledgerCalls ?? "unmeasured"} new calls)` : `FAIL (${JSON.stringify(replay)})`) : `skipped (${replay.reason})`}`);
  console.log(`saved ${out}`);
  return 0;
}

function stop(message, code) {
  console.error(message);
  return code;
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => {
    console.error(e?.stack ?? e);
    process.exitCode = 1;
  },
);
