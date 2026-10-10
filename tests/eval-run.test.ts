// The evaluation runner (scripts/eval-lib.mjs, scripts/eval-run.mjs) against the app's real AI routes
// in-process (the SQL ledger and the legacy file ledger, simulated provider), against scripted servers
// for the failure paths, and the command line's dry run against a stub server. Codex 08:00 review.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as natalPOST } from "@/app/api/ai/natal/route";
import { POST as tarotPOST } from "@/app/api/ai/tarot/route";
import { POST as chatPOST } from "@/app/api/ai/chat/route";
import { POST as horoscopePOST } from "@/app/api/ai/horoscope/route";
import { POST as visitorPOST } from "@/app/api/ai/visitor/route";
import { GET as statusGET } from "@/app/api/ai/status/route";
import { POST as opsPOST } from "@/app/api/ops/session/route";
import { setLedgerForTests } from "@/lib/ledger/factory";
import { resetAiLimits } from "@/lib/ai/guard";
import { resetOpsThrottleForTests } from "@/lib/identity/ops-throttle";
import requests from "../eval/requests.json";
import {
  attribute, CookieJar, ledgerView, makeClient, prepareVisitor, readStatus, replayCheck, requestIdFor, runCase, runEval, signInOperator, summarize, type EvalCase,
} from "../scripts/eval-lib.mjs";
import { LEDGER_TIMEOUT, makeTestLedger, testPlan } from "./helpers/ledger";

const CASES = requests.cases as EvalCase[];
// a test-only operator token for these in-process servers (never a real one)
const OPS = `eval-test-operator-${"x".repeat(12)}`;
const noSleep = async () => undefined;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

type Handler = (req: NextRequest) => Promise<Response> | Response;
const ROUTES: Record<string, Handler> = {
  "POST /api/ai/natal": natalPOST, "POST /api/ai/tarot": tarotPOST, "POST /api/ai/chat": chatPOST, "POST /api/ai/horoscope": horoscopePOST,
  "POST /api/ai/visitor": visitorPOST, "GET /api/ai/status": statusGET, "POST /api/ops/session": opsPOST,
};
/** fetch into the real route handlers, counting AI requests (not status reads or the visitor check). */
function inProcess() {
  const seen: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const key = `${init?.method ?? "GET"} ${u.pathname}`;
    seen.push(key);
    const h = ROUTES[key];
    if (!h) return json(404, { code: "not_found" });
    const headers = { ...(init?.headers as Record<string, string>), "x-forwarded-for": "203.0.113.60" };
    return h(new NextRequest(url, { method: init?.method ?? "GET", body: init?.body as string | undefined, headers }));
  }) as typeof fetch;
  return { fetchImpl, aiRequests: () => seen.filter((k) => /^POST \/api\/ai\/(natal|tarot|chat|horoscope|talk)$/.test(k)).length };
}

function envFor(extra: Record<string, string>) {
  for (const [k, v] of Object.entries({ AI_PROVIDER: "fake", FAKE_AI_FAILURES: "", FAKE_AI_USAGE: "typical", OPS_TOKEN: OPS, ...extra })) vi.stubEnv(k, v);
}
afterEach(() => {
  setLedgerForTests(null);
  resetAiLimits();
  resetOpsThrottleForTests();
  vi.unstubAllEnvs();
});

describe("the evaluation runner on the shared SQL ledger", LEDGER_TIMEOUT, () => {
  beforeEach(async () => {
    envFor({ MOONA_LEDGER: "memory" });
    setLedgerForTests((await makeTestLedger({ plan: testPlan() })).ledger);
  });

  async function setup(operator: boolean) {
    const io = inProcess();
    const ops = makeClient({ base: "http://localhost", fetchImpl: io.fetchImpl });
    const ai = makeClient({ base: "http://localhost", fetchImpl: io.fetchImpl });
    if (operator) expect(await signInOperator(ops, OPS)).toEqual({ operator: true, reason: null });
    const measure = operator ? async () => ledgerView(await readStatus(ops)) : null;
    expect(await prepareVisitor(ai)).toEqual({ ok: true, visitor: "new, kept" });
    return { io, ops, ai, measure };
  }

  it("runs the whole fixed set, attributes each case's cost, and a replay of the same id makes no new call", async () => {
    const { io, ai, measure } = await setup(true);
    const results = await runEval({ client: ai, cases: CASES, runId: "sqlrun01", measure, networkRetries: 1, sleep: noSleep });
    const s = summarize(results);
    expect(CASES).toHaveLength(28);
    expect(s.outcomes).toMatchObject({ completed: 26, handled: 2, failed: 0, refused: 0, lost: 0, not_run: 0 });
    expect(s.ok).toBe(26);
    expect(io.aiRequests()).toBe(28); // one request per case: no hidden retries
    expect(s.modelCalls).toEqual({ inferred: 26, unknown: 0, measured: 26 });
    expect(s.costUsd).toBeGreaterThan(0);
    expect(s.costAttributed).toMatchObject({ cases: 28, of: 28 });
    for (const r of results.filter((x) => x.expectCode)) {
      expect(r.costUsd).toBe(0);
      expect(r.checks.every((k) => k.pass), r.id).toBe(true); // handled as crisis, and no model call per the ledger
    }
    expect(new Set(results.map((r) => r.requestId)).size).toBe(28);
    const replay = await replayCheck(ai, results, CASES, { measure, sleep: noSleep });
    expect(replay).toMatchObject({ ran: true, replayed: true, sameText: true, ledgerCalls: 0, costUsd: 0, pass: true });
  });

  it("without an operator device, reports cost as unknown (never 0), and the public status has no spending", async () => {
    const { ai } = await setup(false);
    const status = await readStatus(ai);
    expect(status).not.toHaveProperty("budget");
    expect(ledgerView(status)).toBeNull();
    const results = await runEval({ client: ai, cases: CASES.filter((c) => ["T1", "H1", "X1"].includes(c.id)), runId: "sqlrun02", measure: null, sleep: noSleep });
    expect(results.map((r) => r.costUsd)).toEqual([null, null, null]);
    expect(results[0].costNote).toMatch(/operator/);
    const s = summarize(results);
    expect(s.costUsd).toBeNull();
    expect(s.modelCalls).toMatchObject({ inferred: 2, measured: null });
  });

  it("stops a route at its free quota with one visitor (no new visitors), and keeps going elsewhere", async () => {
    const base = testPlan();
    setLedgerForTests((await makeTestLedger({ plan: testPlan({ windows: [{ ...base.windows[0], quota: { tarot: [1, 10] } }] }) })).ledger);
    const { io, ai } = await setup(false);
    const some = CASES.filter((c) => ["T1", "T2", "T3", "N1", "X1"].includes(c.id));
    const results = await runEval({ client: ai, cases: some, runId: "sqlrun03", measure: null, sleep: noSleep });
    expect(results.map((r) => [r.id, r.outcome, r.code])).toEqual([
      ["N1", "completed", "ok"], ["T1", "completed", "ok"], ["T2", "refused", "quota"], ["T3", "not_run", "not_run"], ["X1", "handled", "crisis"],
    ]);
    expect(results.find((r) => r.id === "T3")?.reason).toMatch(/quota/);
    expect(io.aiRequests()).toBe(4); // T3 never sent
  });
});

describe("the evaluation runner on the legacy file ledger", LEDGER_TIMEOUT, () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moona-eval-"));
    envFor({ MOONA_LEDGER: "file", AI_USAGE_FILE: join(dir, "usage.json") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the file ledger's shape, attributes cost, and never re-sends (it has no replay)", async () => {
    const io = inProcess();
    const ops = makeClient({ base: "http://localhost", fetchImpl: io.fetchImpl });
    const ai = makeClient({ base: "http://localhost", fetchImpl: io.fetchImpl });
    expect((await signInOperator(ops, OPS)).operator).toBe(true);
    const view = ledgerView(await readStatus(ops));
    expect(view).toMatchObject({ kind: "file", spentMicro: 0, heldMicro: 0, calls: 0 });
    expect((await prepareVisitor(ai)).ok).toBe(true);
    const measure = async () => ledgerView(await readStatus(ops));
    const results = await runEval({ client: ai, cases: CASES.filter((c) => ["T1", "N1", "X2"].includes(c.id)), runId: "filerun1", measure, networkRetries: 0, sleep: noSleep });
    expect(results.map((r) => r.outcome)).toEqual(results.map((r) => (r.expectCode ? "handled" : "completed")));
    expect(results.every((r) => r.costUsd !== null && r.ledgerCalls === (r.expectCode ? 0 : 1))).toBe(true);
    expect(summarize(results).modelCalls).toEqual({ inferred: 2, unknown: 0, measured: 2 });
  });
});

/** A scripted server: the visitor check, then one handler per AI request. */
function scripted(ai: (body: Record<string, unknown>, n: number) => Response | Promise<Response>, o: { keepsCookie?: boolean } = {}) {
  const posts: Record<string, unknown>[] = [];
  let visits = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const cookie = String((init?.headers as Record<string, string>)?.Cookie ?? "");
    if (path === "/api/ai/visitor") {
      visits++;
      const known = cookie.includes("moona_vid=");
      const res = new Response(null, { status: 204, headers: { "x-moona-visitor": known ? "known" : "new" } });
      if (!known && o.keepsCookie !== false) res.headers.append("set-cookie", "moona_vid=v.signed; Path=/; HttpOnly; SameSite=Lax");
      return res;
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    posts.push(body);
    return ai(body, posts.length);
  }) as typeof fetch;
  return { client: makeClient({ base: "http://x", fetchImpl }), posts, visits: () => visits };
}
const T1 = CASES.find((c) => c.id === "T1")!;
const tarotReply = { cards: [{ position: 0, insight: "a" }], synthesis: "s", action: "a", reflection: "r", meta: { provider: "fake", model: "simulated", source: "simulated" } };

describe("the evaluation runner's failure paths", () => {
  it("stops before any AI request when the server's visitor cookie does not stick", async () => {
    const s = scripted(() => json(200, tarotReply), { keepsCookie: false });
    expect(await prepareVisitor(s.client)).toEqual({ ok: false, reason: "cookie_dropped" });
    expect(s.visits()).toBe(2);
    expect(s.posts).toHaveLength(0);
  });

  it("waits (bounded) on 202 with the same request id, then takes the answer", async () => {
    const s = scripted((_, n) => (n < 3 ? json(202, { code: "in_progress", retryAfterMs: 2000 }) : json(200, tarotReply)));
    const r = await runCase(s.client, T1, { requestId: requestIdFor("w", "T1"), sleep: noSleep });
    expect(r).toMatchObject({ outcome: "completed", attempts: 3, waits: 2, inferredCalls: 1 });
    expect(new Set(s.posts.map((p) => p.requestId))).toEqual(new Set([requestIdFor("w", "T1")]));
  });

  it("gives up waiting after the bound, as pending (never a new request)", async () => {
    const s = scripted(() => json(202, { code: "in_progress", retryAfterMs: 5000 }));
    let t = 0;
    const r = await runCase(s.client, T1, { requestId: requestIdFor("p", "T1"), maxWaitMs: 20_000, sleep: async (ms) => { t += ms; }, now: () => t });
    expect(r.outcome).toBe("pending");
    expect(r.attempts).toBeLessThanOrEqual(5);
    expect(new Set(s.posts.map((p) => p.requestId)).size).toBe(1);
  });

  it("retries a lost response once with the same id where the ledger replays, and records it otherwise", async () => {
    let calls = 0;
    const lossy = scripted(() => (++calls === 1 ? Promise.reject(new TypeError("socket hang up")) : json(200, { ...tarotReply, replayed: true })));
    const r = await runCase(lossy.client, T1, { requestId: requestIdFor("n", "T1"), networkRetries: 1, sleep: noSleep });
    expect(r).toMatchObject({ outcome: "completed", attempts: 2, lostResponses: 1, inferredCalls: null });
    expect(lossy.posts.map((p) => p.requestId)).toEqual([requestIdFor("n", "T1"), requestIdFor("n", "T1")]);
    const once = scripted(() => Promise.reject(new TypeError("socket hang up")));
    const r2 = await runCase(once.client, T1, { requestId: requestIdFor("n2", "T1"), networkRetries: 0, sleep: noSleep });
    expect(r2).toMatchObject({ outcome: "lost", attempts: 1, code: "network", costUsd: null });
    expect(once.posts).toHaveLength(1);
  });

  it("stops the whole run when the budget is spent, and marks the rest as not run", async () => {
    const s = scripted((_, n) => (n === 1 ? json(200, tarotReply) : json(503, { code: "budget" })));
    const some = CASES.slice(0, 5);
    const results = await runEval({ client: s.client, cases: some, runId: "b", measure: null, sleep: noSleep });
    expect(results.map((r) => r.outcome)).toEqual(["completed", "refused", "not_run", "not_run", "not_run"]);
    expect(results[2].reason).toMatch(/budget/);
    expect(s.posts).toHaveLength(2);
    expect(summarize(results).outcomes).toMatchObject({ completed: 1, refused: 1, not_run: 3 });
  });

  it("does not attribute cost when other traffic ran or settled during a case", () => {
    const q = (o: Partial<{ spentMicro: number; heldMicro: number; calls: number; inflight: number }>) => ({ kind: "sql" as const, spentMicro: 0, heldMicro: 0, calls: 0, inflight: 0, ...o });
    expect(attribute(q({}), q({ spentMicro: 1500, calls: 1 }), 1)).toEqual({ costUsd: 0.0015, ledgerCalls: 1, costNote: null });
    expect(attribute(q({}), q({ spentMicro: 3000, calls: 2 }), 1).costUsd).toBeNull(); // someone else's call too
    expect(attribute(q({ inflight: 1, heldMicro: 900 }), q({ spentMicro: 1500, calls: 1 }), 1).costUsd).toBeNull(); // another request in flight
    expect(attribute(null, null, 1)).toMatchObject({ costUsd: null, ledgerCalls: null });
    expect(attribute(q({}), q({ spentMicro: 1500, calls: 1 }), null)).toMatchObject({ costUsd: null, ledgerCalls: 1, costNote: expect.stringMatching(/lost or delayed/) });
  });

  it("reads both ledger shapes from an operator's status, and nothing from the public one", () => {
    expect(ledgerView({ available: true, provider: "fake" })).toBeNull();
    expect(ledgerView({ budget: { kind: "sql", planId: "dev", activeWindowId: "win:dev", gate: { inflight: 0, breaker: "ok" }, pools: [{ id: "ai", kind: "ai", capMicro: 25e6, spentMicro: 12, heldMicro: 0, callsUsed: 3 }, { id: "win:dev", kind: "window", capMicro: 5e6, spentMicro: 12, heldMicro: 0, callsUsed: 3, callsCap: null }] } }))
      .toMatchObject({ kind: "sql", spentMicro: 12, heldMicro: 0, calls: 3, inflight: 0, window: { id: "win:dev", callsUsed: 3 } });
    expect(ledgerView({ budget: { day: "2026-10-10", callsToday: 4, usdToday: 0.5, usdTotal: 1.25, reservedUsdTotal: 0, reservedUsdToday: 0, durable: true, limits: { maxUsdTotal: 25, maxUsdPerDay: 5, maxCallsPerDay: 300 } } }))
      .toMatchObject({ kind: "file", spentMicro: 1_250_000, heldMicro: 0, calls: 4, capMicro: 25_000_000 });
  });

  it("keeps one stable request id per case that the server accepts, and a cookie jar that forgets expired cookies", () => {
    const id = requestIdFor("Ab3_9-zz", "N1");
    expect(id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(requestIdFor("Ab3_9-zz", "N1")).toBe(id);
    const jar = new CookieJar();
    const res = new Response(null, { headers: [["set-cookie", "moona_vid=abc; Path=/"], ["set-cookie", "moona_ops=def; Max-Age=43200"]] });
    jar.absorb(res);
    expect(jar.header()).toBe("moona_vid=abc; moona_ops=def");
    jar.absorb(new Response(null, { headers: [["set-cookie", "moona_ops=; Max-Age=0"]] }));
    expect(jar.has("moona_ops")).toBe(false);
  });
});

describe("the command line's dry run", () => {
  it("reads only the status, sends no AI request, makes no visitor, and exits 0", async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.url === "/api/ai/status" ? { available: true, level: null, provider: "fake", model: "simulated" } : { code: "unexpected" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const env = { ...process.env };
    delete env.OPS_TOKEN;
    delete env.MOONA_EVAL_OPS_TOKEN;
    const run = spawn(process.execPath, ["scripts/eval-run.mjs", "--base", `http://127.0.0.1:${port}`, "--only", "T1"], { env });
    let out = "";
    run.stdout.on("data", (d) => (out += d));
    run.stderr.on("data", (d) => (out += d));
    const code = await new Promise<number>((r) => run.on("close", (c) => r(c ?? -1)));
    server.close();
    expect(code, out).toBe(0);
    expect(hits).toEqual(["GET /api/ai/status"]);
    expect(out).toContain("Dry run: no AI request was sent");
    expect(out).toContain("spending: hidden");
    expect(out).toContain("fake provider: simulated replies");
  });
});

describe("the evaluation runner after its review (verify-eval findings)", () => {
  it("keeps going and records a sent case when a ledger read fails mid-run", async () => {
    const s = scripted(() => json(200, tarotReply));
    let reads = 0;
    const measure = async () => {
      if (++reads === 2) throw new TypeError("fetch failed"); // the read after the first case
      return { kind: "sql" as const, spentMicro: 0, heldMicro: 0, calls: 0, inflight: 0 };
    };
    const results = await runEval({ client: s.client, cases: CASES.filter((c) => ["T1", "T2"].includes(c.id)), runId: "readfail", measure, sleep: noSleep });
    expect(results.map((r) => r.outcome)).toEqual(["completed", "completed"]);
    expect(results[0]).toMatchObject({ costUsd: null, costNote: expect.stringMatching(/reading the ledger failed/) });
  });

  it("counts a joined shared request that comes back replayed as a replay, not this case's call", async () => {
    const s = scripted((_, n) => (n === 1 ? json(202, { code: "in_progress", retryAfterMs: 500 }) : json(200, { ...tarotReply, replayed: true })));
    const r = await runCase(s.client, T1, { requestId: requestIdFor("join", "T1"), sleep: noSleep });
    expect(r).toMatchObject({ outcome: "replayed", inferredCalls: 0, waits: 1 });
  });

  it("attributes an unbilled provider failure (the ledger takes the call back) instead of blaming other traffic", () => {
    const q = (o: Partial<{ spentMicro: number; heldMicro: number; calls: number; inflight: number }>) => ({ kind: "sql" as const, spentMicro: 0, heldMicro: 0, calls: 0, inflight: 0, ...o });
    expect(attribute(q({}), q({}), [0, 1])).toEqual({ costUsd: 0, ledgerCalls: 0, costNote: null });
    // one more call could be its own billed failure or someone else's request: not attributed
    expect(attribute(q({}), q({ spentMicro: 900, calls: 1 }), [0, 1])).toMatchObject({ costUsd: null, ledgerCalls: 1, costNote: expect.stringMatching(/may or may not have been billed/) });
    expect(attribute(q({}), q({ calls: 2 }), [0, 1]).costUsd).toBeNull();
  });

  it("attributes cost while money stays held for other reasons (a pack lot, a hold the file ledger keeps)", () => {
    const q = (o: Partial<{ spentMicro: number; heldMicro: number; calls: number; inflight: number }>) => ({ kind: "sql" as const, spentMicro: 0, heldMicro: 2_000_000, calls: 0, inflight: 0, ...o });
    expect(attribute(q({}), q({ spentMicro: 1500, calls: 1 }), 1)).toMatchObject({ costUsd: 0.0015 });
    expect(attribute(q({}), q({ spentMicro: 1500, calls: 1, heldMicro: 2_100_000 }), 1)).toMatchObject({ costUsd: null, costNote: expect.stringMatching(/money held changed/) }); // something new is held
    const f = (o: Partial<{ spentMicro: number; calls: number }>) => ({ kind: "file" as const, spentMicro: 0, heldMicro: 39_138, calls: 0, inflight: null, day: "2026-10-10", ...o });
    expect(attribute(f({}), f({ spentMicro: 13_600, calls: 1 }), 1)).toEqual({ costUsd: 0.0136, ledgerCalls: 1, costNote: "the file ledger reports spending to $0.0001" });
  });

  it("records a 200 that isn't JSON (a captive portal) as an error, not an answer", async () => {
    const s = scripted(() => new Response("<html>Wi-Fi login</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    const r = await runCase(s.client, T1, { requestId: requestIdFor("html", "T1"), sleep: noSleep });
    expect(r).toMatchObject({ outcome: "error", code: "bad_response", inferredCalls: null });
    expect(summarize([r]).ok).toBe(0);
  });

  it("does not take a visitor check without its cookie as confirmed", async () => {
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch; // no header, no cookie
    expect(await prepareVisitor(makeClient({ base: "http://x", fetchImpl }))).toEqual({ ok: false, reason: "cookie_dropped" });
  });

  it("never re-sends on the file ledger, even when told the request is still running", async () => {
    const s = scripted(() => json(202, { code: "in_progress", retryAfterMs: 500 }));
    const r = await runCase(s.client, T1, { requestId: requestIdFor("file", "T1"), resend: false, sleep: noSleep });
    expect(r).toMatchObject({ outcome: "pending", attempts: 1 });
    expect(s.posts).toHaveLength(1);
  });

  it("still sends the crisis cases after a global stop (they are answered before any ledger check)", async () => {
    const s = scripted((_, n) => (n === 1 ? json(503, { code: "budget" }) : json(200, { code: "crisis" })));
    const results = await runEval({ client: s.client, cases: CASES.filter((c) => ["T1", "T2", "X1", "X2"].includes(c.id)), runId: "crisis", measure: null, sleep: noSleep });
    expect(results.map((r) => [r.id, r.outcome])).toEqual([["T1", "refused"], ["T2", "not_run"], ["X1", "handled"], ["X2", "handled"]]);
  });

  it("splits a joined Set-Cookie header without breaking at the comma inside Expires", () => {
    const jar = new CookieJar();
    jar.absorb({ headers: { get: () => "a=1; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT, b=2; Path=/" } } as unknown as Response);
    expect(jar.header()).toBe("a=1; b=2");
  });

  it("measures latency on cases answered by a model call only, not on cache replays", () => {
    const base = { kind: "tarot", endpoint: "/api/ai/tarot", expectCode: null, requestId: "x", httpStatus: 200, code: "ok", attempts: 1, lostResponses: 0, waits: 0, costUsd: null, ledgerCalls: null, costNote: null, text: "", checks: [], response: null, error: null };
    const s = summarize([
      { ...base, id: "T1", outcome: "completed", inferredCalls: 1, latencyMs: 900 },
      { ...base, id: "H1", outcome: "replayed", inferredCalls: 0, latencyMs: 12 },
    ] as never);
    expect(s.latencyMs).toMatchObject({ p50: 900, max: 900 });
  });
});

describe("the command line's exit codes", () => {
  type Route = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;
  async function stub(routes: Record<string, Route>) {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const r = routes[`${req.method} ${req.url}`];
      if (r) return r(req, res);
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { hits, port: (server.address() as { port: number }).port, close: () => server.close() };
  }
  async function cli(port: number, extra: string[], env: Record<string, string | undefined>) {
    const e = { ...process.env, ...env };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k];
    const run = spawn(process.execPath, ["scripts/eval-run.mjs", "--base", `http://127.0.0.1:${port}`, "--only", "T1", ...extra], { env: e });
    let out = "";
    run.stdout.on("data", (d) => (out += d));
    run.stderr.on("data", (d) => (out += d));
    const code = await new Promise<number>((r) => run.on("close", (c) => r(c ?? -1)));
    return { code, out };
  }
  const status = (body: unknown): Route => (_, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
  const signIn: Route = (_, res) => { res.setHeader("Set-Cookie", "moona_ops=signed; Path=/; HttpOnly"); res.setHeader("Content-Type", "application/json"); res.end('{"operator":true}'); };
  const OPS_ENV = { MOONA_EVAL_OPS_TOKEN: "stub-operator-token-0123456789", OPS_TOKEN: undefined };

  it("exits 0 from a dry run after an operator sign-in (two requests, then the exit)", async () => {
    const s = await stub({ "POST /api/ops/session": signIn, "GET /api/ai/status": status({ available: true, provider: "fake", model: "simulated", budget: { kind: "sql", pools: [], gate: { inflight: 0, breaker: "ok" } } }) });
    const r = await cli(s.port, [], OPS_ENV);
    s.close();
    expect(r.code, r.out).toBe(0);
    expect(s.hits).toEqual(["POST /api/ops/session", "GET /api/ai/status"]);
    expect(r.out).not.toContain("stub-operator-token-0123456789");
  });

  it("exits 2 before any AI request when the visitor cookie does not stick", async () => {
    const s = await stub({
      "GET /api/ai/status": status({ available: true, provider: "fake", model: "simulated" }),
      "POST /api/ai/visitor": (_, res) => { res.statusCode = 204; res.setHeader("x-moona-visitor", "new"); res.end(); },
    });
    const r = await cli(s.port, ["--yes", "--out", join(tmpdir(), `moona-eval-stub-${process.pid}.json`)], { MOONA_EVAL_OPS_TOKEN: undefined, OPS_TOKEN: undefined });
    s.close();
    expect(r.code, r.out).toBe(2);
    expect(s.hits.filter((h) => h.startsWith("POST /api/ai/") && h !== "POST /api/ai/visitor")).toHaveLength(0);
  });

  it("exits 1 before sending anything when the result file can't be written", async () => {
    const s = await stub({
      "GET /api/ai/status": status({ available: true, provider: "fake", model: "simulated" }),
      "POST /api/ai/visitor": (_, res) => { res.statusCode = 204; res.setHeader("x-moona-visitor", "known"); res.end(); },
    });
    const dir = mkdtempSync(join(tmpdir(), "moona-eval-out-"));
    const r = await cli(s.port, ["--yes", "--out", dir], { MOONA_EVAL_OPS_TOKEN: undefined, OPS_TOKEN: undefined }); // a directory, not a file
    s.close();
    rmSync(dir, { recursive: true, force: true });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("Nothing was sent");
    expect(s.hits).toEqual(["GET /api/ai/status"]);
  });

  it("exits 1 when AI is not available, after an operator sign-in", async () => {
    const s = await stub({ "POST /api/ops/session": signIn, "GET /api/ai/status": status({ available: false, reason: "budget" }) });
    const r = await cli(s.port, [], OPS_ENV);
    s.close();
    expect(r.code, r.out).toBe(1);
  });
});
