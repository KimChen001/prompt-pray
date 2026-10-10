// The evaluation runner's logic (scripts/eval-run.mjs is the command line). It talks to a running
// MOONA server the way the browser does (src/lib/ai/client.ts):
// - one visitor, confirmed to keep its cookie before any AI request, and never a new visitor to get
//   around a quota;
// - one request id per case, kept for every wait and retry, so the ledger replays or joins the
//   request instead of starting another one;
// - bounded waits for "still running" (202) and "busy", and no automatic retry unless the ledger is
//   known to replay (the SQL ledger; the legacy file ledger has no replay, so nothing is re-sent there).
// Spending is visible only to an operator device: the public status hides it. Without one, cost is
// reported as unknown (null), never as 0. A case's cost is its ledger change, and it is only
// attributed when nothing else was running or settling meanwhile.

export const DEFAULTS = { maxWaitMs: 120_000, requestTimeoutMs: 150_000 };
export const VISITOR_COOKIE = "moona_vid";
export const OPS_COOKIE = "moona_ops";
export const ACCESS_COOKIE = "moona-ai-access";
const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;

// Refusals: these stop the rest of the cases on the same route (a quota is per route), or all of them.
const STOP_ROUTE = new Set(["quota", "subject_failures"]);
const STOP_ALL = new Set(["budget", "paused", "ledger", "locked", "unconfigured", "misconfigured", "paid_capacity", "visitor_cap", "rate_limited", "login_required"]);
// Failures after the provider was called: billed (its answer was unusable, or it ran out of time and
// the bound is charged), or maybe not (it turned the request away, e.g. rate limited, unbilled).
const BILLED_FAILURE = new Set(["timeout", "bad_output"]);
const MAYBE_BILLED_FAILURE = new Set(["upstream", "refused"]);

/** Cookies for one server origin. Values are never printed. */
export class CookieJar {
  #c = new Map();
  absorb(res) {
    // a joined header is split at the commas that start a new cookie (not the one inside Expires)
    const joined = res.headers.get("set-cookie");
    const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : joined ? joined.split(/,(?=\s*[^;,=\s]+=)/) : [];
    for (const line of lines) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => {
        const [k, v = ""] = a.split("=").map((x) => x.trim());
        return (/^max-age$/i.test(k) && Number(v) <= 0) || (/^expires$/i.test(k) && Date.parse(v) <= Date.now());
      });
      if (expired || value === "") this.#c.delete(name);
      else this.#c.set(name, value);
    }
  }
  set(name, value) {
    this.#c.set(name, value);
  }
  has(name) {
    return this.#c.has(name);
  }
  header() {
    return [...this.#c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export function makeClient({ base, fetchImpl = fetch, jar = new CookieJar(), requestTimeoutMs = DEFAULTS.requestTimeoutMs }) {
  const root = String(base).replace(/\/+$/, "");
  async function call(path, method = "GET", body) {
    const cookie = jar.header();
    const headers = { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) };
    const res = await fetchImpl(`${root}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(requestTimeoutMs) });
    jar.absorb(res);
    return res;
  }
  return { base: root, jar, get: (p) => call(p), post: (p, body) => call(p, "POST", body) };
}

/** Signs this client in as an operator device. The token is sent once and never printed. */
export async function signInOperator(client, token) {
  if (!token) return { operator: false, reason: "no operator token configured" };
  let res;
  try {
    res = await client.post("/api/ops/session", { token });
  } catch {
    return { operator: false, reason: "the operator sign-in did not answer" };
  }
  if (res.ok && client.jar.has(OPS_COOKIE)) return { operator: true, reason: null };
  const why = { 404: "operator sign-in is not enabled on this server (OPS_TOKEN unset)", 401: "the operator token was refused", 429: "too many failed operator sign-ins from this network" }[res.status];
  return { operator: false, reason: why ?? `operator sign-in answered HTTP ${res.status}` };
}

export async function readStatus(client) {
  const res = await client.get("/api/ai/status");
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== "object") throw new Error(`the status answered HTTP ${res.status} without JSON`);
  return body;
}

/**
 * What an operator's status says about spending, in one shape for both ledgers, or null when the
 * status carries no spending (any non-operator: the public status hides it by design).
 */
export function ledgerView(status) {
  const b = status?.budget;
  if (!b || typeof b !== "object") return null;
  if (b.kind === "sql") {
    const pools = Array.isArray(b.pools) ? b.pools : [];
    const ai = pools.find((p) => p.kind === "ai");
    const win = pools.find((p) => p.id === b.activeWindowId) ?? null;
    if (!ai) return { kind: "sql", spentMicro: null, heldMicro: null, calls: null, inflight: b.gate?.inflight ?? null, capMicro: null, window: null, breaker: b.gate?.breaker ?? null, planId: b.planId ?? null };
    return {
      kind: "sql", spentMicro: ai.spentMicro, heldMicro: ai.heldMicro, calls: ai.callsUsed, inflight: b.gate?.inflight ?? null, capMicro: ai.capMicro,
      window: win ? { id: win.id, spentMicro: win.spentMicro, heldMicro: win.heldMicro, capMicro: win.capMicro, callsUsed: win.callsUsed, callsCap: win.callsCap } : null,
      breaker: b.gate?.breaker ?? null, planId: b.planId ?? null,
    };
  }
  if (typeof b.usdTotal === "number") {
    const micro = (usd) => (typeof usd === "number" ? Math.round(usd * 1e6) : null);
    return {
      kind: "file", spentMicro: micro(b.usdTotal), heldMicro: micro(b.reservedUsdTotal ?? 0), calls: b.callsToday ?? null, inflight: null, day: b.day ?? null,
      capMicro: micro(b.limits?.maxUsdTotal), today: { spentMicro: micro(b.usdToday), capMicro: micro(b.limits?.maxUsdPerDay), calls: b.callsToday ?? null, callsCap: b.limits?.maxCallsPerDay ?? null },
    };
  }
  return { kind: "unknown", spentMicro: null, heldMicro: null, calls: null, inflight: null };
}

const usd = (micro) => (micro === null || micro === undefined ? "?" : `$${(micro / 1e6).toFixed(4)}`);

export function describeLedger(v) {
  if (!v) return "spending: hidden (this is not an operator device), so cost will be reported as unknown";
  if (v.kind === "sql") {
    const w = v.window ? `; window ${v.window.id} ${usd(v.window.spentMicro)} of ${usd(v.window.capMicro)}, ${v.window.callsUsed}${v.window.callsCap ? `/${v.window.callsCap}` : ""} calls` : "; no active window";
    return `shared ledger (SQL, plan ${v.planId ?? "none"}): AI ${usd(v.spentMicro)} spent + ${usd(v.heldMicro)} held of ${usd(v.capMicro)}${w}; breaker ${v.breaker ?? "?"}`;
  }
  if (v.kind === "file") return `legacy file ledger: ${usd(v.spentMicro)} of ${usd(v.capMicro)} total; today ${usd(v.today.spentMicro)} of ${usd(v.today.capMicro)}, ${v.today.calls ?? "?"}/${v.today.callsCap ?? "?"} calls`;
  return "spending: the ledger reported an unknown shape, so cost will be reported as unknown";
}

/**
 * Makes sure the server knows this client as one visitor that keeps its cookie, before any AI
 * request (as the browser does): "new" is asked once more, and must come back "known".
 */
export async function prepareVisitor(client) {
  const ask = async () => {
    let res;
    try {
      res = await client.post("/api/ai/visitor");
    } catch {
      return { ok: false, reason: "network" };
    }
    if (res.status === 204) return { ok: true, state: res.headers.get("x-moona-visitor") };
    const body = await res.json().catch(() => ({}));
    return { ok: false, reason: typeof body?.code === "string" ? body.code : `http_${res.status}` };
  };
  const first = await ask();
  if (!first.ok) return first;
  if (first.state === "known" && client.jar.has(VISITOR_COOKIE)) return { ok: true, visitor: "known" };
  const second = await ask();
  if (!second.ok) return second;
  if (second.state === "known" && client.jar.has(VISITOR_COOKIE)) return { ok: true, visitor: first.state === "new" ? "new, kept" : "confirmed" };
  return { ok: false, reason: second.state === "new" || !client.jar.has(VISITOR_COOKIE) ? "cookie_dropped" : "unconfirmed" };
}

/** A stable id per logical case and run (the server keys replay on visitor + route + this id). */
export function requestIdFor(runId, caseId) {
  const id = `moona-eval-${String(runId).padStart(4, "0")}-${caseId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  if (!REQUEST_ID.test(id)) throw new Error(`moona-eval: bad request id ${id}`);
  return id;
}

/** Whether a 200 body has the shape of this route's answer. */
function looksLikeAnswer(kind, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const field = { natal: "overview", tarot: "synthesis", chat: "reply", horoscope: "overall" }[kind];
  return field ? typeof body[field] === "string" : true;
}

/** All model-written text in a response, for checks and for graders. */
export function outputText(kind, body) {
  if (!body || body.code) return "";
  if (kind === "natal") return [body.overview, ...(body.themes ?? []).map((t) => t.text)].join("\n\n");
  if (kind === "tarot") return [...(body.cards ?? []).map((c) => c.insight), body.synthesis, body.action, body.reflection].join("\n\n");
  if (kind === "chat") return [body.reply, body.remember ? `[remember] ${body.remember.text} ← "${body.remember.quote}"` : ""].filter(Boolean).join("\n\n");
  if (kind === "horoscope") return [body.overall, body.love, body.work].join("\n\n");
  return "";
}

/**
 * A case's ledger change, attributed only when nothing else ran or settled meanwhile: no request in
 * flight, the money held unchanged (a pack lot's allocation, or a hold the file ledger keeps, is not
 * traffic), and the call count moved by what the case did (a number, or [min, max] when a failure may
 * have gone unbilled; null when that can't be known).
 */
export function attribute(before, after, expected) {
  if (!before || !after) return { costUsd: null, ledgerCalls: null, costNote: "unknown: spending is visible to operator devices only" };
  if (before.kind !== after.kind || before.spentMicro === null || after.spentMicro === null || before.calls === null || after.calls === null) return { costUsd: null, ledgerCalls: null, costNote: "unknown: the ledger did not report spending" };
  const ledgerCalls = after.calls - before.calls;
  const range = expected === null ? null : Array.isArray(expected) ? expected : [expected, expected];
  const quiet = after.heldMicro === before.heldMicro && (before.inflight ?? 0) === 0 && (after.inflight ?? 0) === 0 && (before.kind !== "file" || before.day === after.day);
  if (after.heldMicro !== before.heldMicro) {
    return { costUsd: null, ledgerCalls, costNote: "unknown: the money held changed during this case (a request still unsettled, this case's or another's)" };
  }
  if (!quiet || (range && (ledgerCalls < range[0] || ledgerCalls > range[1]))) {
    return { costUsd: null, ledgerCalls, costNote: "unknown: other requests ran or settled during this case, so its share can't be told apart" };
  }
  // a failure that may have gone unbilled: one more call could be its own or someone else's
  if (range && range[0] !== range[1] && ledgerCalls !== range[0]) {
    return { costUsd: null, ledgerCalls, costNote: "unknown: the provider failure may or may not have been billed, so the call counted can't be told apart from another request's" };
  }
  if (!range) {
    return { costUsd: null, ledgerCalls, costNote: "unknown: a response was lost or delayed, so this case's ledger change can't be checked against what it did" };
  }
  const costUsd = +((after.spentMicro - before.spentMicro) / 1e6).toFixed(6);
  return { costUsd, ledgerCalls, costNote: before.kind === "file" ? "the file ledger reports spending to $0.0001" : null };
}

/**
 * Sends one case, with one request id for every attempt: waits (bounded) while the server says it is
 * still running or busy, and retries a lost response only when the ledger is known to replay.
 */
export async function runCase(client, c, o) {
  const { requestId, maxWaitMs = DEFAULTS.maxWaitMs, networkRetries = 0, resend = true, sleep, now = () => Date.now(), measure } = o;
  // a failed ledger read never stops the run or loses a case that was sent: its cost is just unknown
  let readFailed = false;
  const read = async () => {
    if (!measure) return null;
    try {
      return await measure();
    } catch {
      readFailed = true;
      return null;
    }
  };
  const before = await read();
  const t0 = now();
  let attempts = 0, lost = 0, waits = 0, res = null, body = null, error = null, stillRunning = false, firstMs = null;
  for (;;) {
    attempts++;
    try {
      res = await client.post(c.endpoint, { ...c.body, requestId });
      body = await res.json().catch(() => null);
      error = null;
      if (firstMs === null) firstMs = now() - t0;
    } catch (e) {
      res = null;
      body = null;
      error = String(e?.message ?? e);
      if (lost < networkRetries) {
        lost++;
        await sleep(1000 * lost);
        continue; // the same id: the server replays it, or joins it if it is still running
      }
      lost++;
      break;
    }
    const code = typeof body?.code === "string" ? body.code : null;
    stillRunning = res.status === 202 || (res.status === 503 && (code === "busy" || code === "cooldown")) || (res.status === 429 && code === "subject_busy");
    if (!stillRunning || !resend) break; // without replay (the file ledger) a re-send would be a second call
    const ms = Math.min(5000, Math.max(500, Number(body?.retryAfterMs) || 2000));
    if (now() - t0 + ms > maxWaitMs) break;
    waits++;
    await sleep(ms);
  }
  const after = await read();
  const httpStatus = res?.status ?? 0;
  // a 200 that isn't this route's answer (a captive portal, a proxy page, JSON of another shape) is not one
  const code = error ? "network" : typeof body?.code === "string" ? body.code : httpStatus === 200 ? (looksLikeAnswer(c.kind, body) ? "ok" : "bad_response") : `http_${httpStatus}`;
  // calls: what this case made the model do, as far as the answers show (null: can't be known);
  // expect: what the ledger's call count may move by for the cost to be this case's alone
  let outcome, calls, expect;
  if (error) [outcome, calls] = ["lost", null];
  // A replay with no lost response is an earlier or shared answer (a 202 on a new id can only have
  // joined someone else's identical request): no call by this case. After a lost response it may be
  // this request's own answer, so the count is unknown.
  else if (httpStatus === 200 && code === "ok") [outcome, calls] = body?.replayed === true ? (lost ? ["completed", null] : ["replayed", 0]) : ["completed", 1];
  else if (code === "bad_response") [outcome, calls] = ["error", null];
  else if (httpStatus === 200) [outcome, calls] = ["handled", 0]; // e.g. crisis: answered before any model call
  else if (stillRunning) [outcome, calls] = ["pending", null];
  else if (httpStatus === 409 && code === "retry_new_key") [outcome, calls] = ["failed", lost ? null : 0]; // an earlier attempt with this id failed
  else if (BILLED_FAILURE.has(code)) [outcome, calls] = ["failed", lost ? null : 1];
  else if (MAYBE_BILLED_FAILURE.has(code)) [outcome, calls, expect] = ["failed", null, lost ? null : [0, 1]];
  else if (STOP_ROUTE.has(code) || STOP_ALL.has(code) || httpStatus === 429 || httpStatus === 503) [outcome, calls] = ["refused", 0];
  else [outcome, calls] = ["error", null];
  const cost = readFailed
    ? { costUsd: null, ledgerCalls: null, costNote: "unknown: reading the ledger failed during this case" }
    : code === "bad_response"
      ? { ...attribute(before, after, null), costUsd: null, costNote: "unknown: the server's answer wasn't readable" }
      : attribute(before, after, expect === undefined ? calls : expect);
  const text = outputText(c.kind, body);
  const checks = [
    ...(c.expectCode ? [{ name: `handled as ${c.expectCode}`, pass: body?.code === c.expectCode }] : []),
    ...(c.expectCode && cost.ledgerCalls !== null ? [{ name: "no model call (ledger)", pass: cost.ledgerCalls === 0 }] : []),
    ...(code === "ok" ? (c.must ?? []).map((k) => ({ name: k.name, pass: new RegExp(k.pattern, k.flags ?? "").test(text) })) : []),
    ...(code === "ok" ? (c.mustNot ?? []).map((k) => ({ name: k.name, pass: !new RegExp(k.pattern, k.flags ?? "").test(text) })) : []),
  ];
  return {
    id: c.id, kind: c.kind, locale: c.locale, covers: c.covers, endpoint: c.endpoint, expectCode: c.expectCode ?? null, requestId,
    outcome, httpStatus, code, attempts, lostResponses: lost, waits, inferredCalls: calls,
    latencyMs: Math.round(now() - t0), firstResponseMs: firstMs === null ? null : Math.round(firstMs),
    ...cost, meta: body?.meta ?? null, text, checks, response: body, error,
  };
}

export function notRun(c, reason) {
  return {
    id: c.id, kind: c.kind, locale: c.locale, covers: c.covers, endpoint: c.endpoint, expectCode: c.expectCode ?? null, requestId: null,
    outcome: "not_run", httpStatus: 0, code: "not_run", reason, attempts: 0, lostResponses: 0, waits: 0, inferredCalls: 0,
    latencyMs: null, firstResponseMs: null, costUsd: 0, ledgerCalls: null, costNote: "not sent", meta: null, text: "", checks: [], response: null, error: null,
  };
}

/** Runs the cases in order; a quota stops its route, a global refusal stops the run. */
export async function runEval({ client, cases, runId, measure, networkRetries = 0, resend = true, maxWaitMs, sleep, now, onResult }) {
  const results = [];
  const stoppedRoutes = new Map();
  let stopped = null;
  for (const c of cases) {
    // the crisis cases are answered before any quota, budget or ledger check, and cost nothing
    const why = c.expectCode ? null : stopped ?? stoppedRoutes.get(c.endpoint);
    if (why) {
      results.push(notRun(c, why));
      await onResult?.(results, results[results.length - 1]);
      continue;
    }
    const r = await runCase(client, c, { requestId: requestIdFor(runId, c.id), measure, networkRetries, resend, maxWaitMs, sleep, now });
    results.push(r);
    await onResult?.(results, r);
    if (r.outcome === "refused") {
      if (STOP_ROUTE.has(r.code)) stoppedRoutes.set(c.endpoint, `${c.endpoint} refused: ${r.code}`);
      else stopped = `stopped after ${c.id}: ${r.code}`;
    }
  }
  return results;
}

/** Sends one completed case again with its request id: the server must replay it, with no new call. */
export async function replayCheck(client, results, cases, o) {
  const done = results.find((r) => r.outcome === "completed" && r.requestId);
  if (!done) return { ran: false, reason: "no completed case to replay" };
  const c = cases.find((x) => x.id === done.id);
  const r = await runCase(client, c, { ...o, requestId: done.requestId, networkRetries: 0 });
  const sameText = r.text === done.text;
  return { ran: true, caseId: done.id, requestId: done.requestId, replayed: r.response?.replayed === true, sameText, ledgerCalls: r.ledgerCalls, costUsd: r.costUsd, pass: r.response?.replayed === true && sameText && (r.ledgerCalls === null || r.ledgerCalls === 0) };
}

const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);

export function summarize(results) {
  const count = (o) => results.filter((r) => r.outcome === o).length;
  const outcomes = Object.fromEntries(["completed", "replayed", "handled", "failed", "refused", "lost", "pending", "error", "not_run"].map((o) => [o, count(o)]));
  const modelCases = results.filter((r) => !r.expectCode);
  const sent = results.filter((r) => r.outcome !== "not_run");
  const known = sent.filter((r) => r.inferredCalls !== null);
  const attributed = sent.filter((r) => r.costUsd !== null);
  const lat = modelCases.filter((r) => r.outcome === "completed" && r.code === "ok").map((r) => r.latencyMs); // not replays from a cache
  const allCosted = sent.length > 0 && attributed.length === sent.length;
  return {
    cases: results.length,
    modelCases: modelCases.length,
    ok: modelCases.filter((r) => r.code === "ok").length,
    outcomes,
    httpAttempts: results.reduce((s, r) => s + r.attempts, 0),
    // what this run made the model do: inferred from the server's answers (a fresh reply or a failure
    // after the call), and measured from the ledger where the change could be attributed
    modelCalls: { inferred: known.reduce((s, r) => s + r.inferredCalls, 0), unknown: sent.length - known.length, measured: allCosted ? sent.reduce((s, r) => s + (r.ledgerCalls ?? 0), 0) : null },
    byCode: Object.fromEntries([...new Set(results.map((r) => r.code))].map((k) => [k, results.filter((r) => r.code === k).length])),
    flagged: results.filter((r) => r.checks.some((k) => !k.pass)).map((r) => r.id),
    costUsd: allCosted ? +attributed.reduce((s, r) => s + r.costUsd, 0).toFixed(6) : null,
    costAttributed: { cases: attributed.length, of: sent.length, usd: +attributed.reduce((s, r) => s + r.costUsd, 0).toFixed(6) },
    costNote: allCosted ? "ledger estimate from the configured prices (check against the provider's dashboard)" : attributed.length ? "partial: some cases' cost could not be attributed (see each case's costNote); the total is unknown" : "unknown: no case's cost could be attributed",
    latencyMs: { p50: pct(lat, 50), p90: pct(lat, 90), max: lat.length ? Math.max(...lat) : null },
  };
}
