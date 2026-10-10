// The browser request helper (spec §11 client): one request id per attempt, "still running" and
// "busy" retried with the same id and body, and every refusal mapped to an honest outcome.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VISITOR_PREPARE_TIMEOUT_MS, newRequestId, requestAi, requestAiOnce, resetVisitorForTests } from "@/lib/ai/client";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => resetVisitorForTests(true)); // the visitor pre-call has its own test below
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("requestAi", () => {
  it("waits out 202 with the same id and body, then resolves", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(202, { code: "in_progress", retryAfterMs: 1000 }))
      .mockResolvedValueOnce(json(200, { reply: "hi", replayed: true, budgetLevel: "warn" }));
    const p = requestAi("/api/ai/talk", { locale: "en" }, { requestId: "id-0000000000000001", fetchImpl });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toEqual({ state: "done", value: { reply: "hi", replayed: true, budgetLevel: "warn" }, replayed: true, budgetLevel: "warn" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bodies = fetchImpl.mock.calls.map((c) => (c[1] as RequestInit).body);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(String(bodies[0]))).toEqual({ locale: "en", requestId: "id-0000000000000001" });
  });

  it("retries busy with jitter and gives up at maxWaitMs", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async () => json(503, { code: "busy", retryAfterMs: 2000 }));
    const p = requestAi("/api/ai/tarot", {}, { requestId: "id-0000000000000002", fetchImpl, maxWaitMs: 10_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await p).toEqual({ state: "offline", reason: "busy" });
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("maps refusals to outcomes", async () => {
    const one = (status: number, body: unknown) => requestAi("/x", {}, { requestId: "id-0000000000000003", fetchImpl: async () => json(status, body) });
    expect(await one(409, { code: "retry_new_key" })).toEqual({ state: "retry" });
    expect(await one(429, { code: "quota", credits: null })).toEqual({ state: "quota", credits: null });
    expect(await one(402, { code: "no_credits" })).toEqual({ state: "no_credits" });
    expect(await one(401, { code: "login_required" })).toEqual({ state: "needs_login" });
    expect(await one(503, { code: "budget" })).toEqual({ state: "offline", reason: "budget", code: "budget" });
    expect(await one(503, { code: "misconfigured" })).toEqual({ state: "offline", reason: "unconfigured", code: "misconfigured" });
    expect(await one(503, {})).toEqual({ state: "offline", reason: "unconfigured" }); // a bare 503 (a gateway) carries no code
    expect(await one(503, { code: "ledger" })).toEqual({ state: "offline", reason: "ledger", code: "ledger" });
    expect(await one(200, { code: "crisis" })).toEqual({ state: "crisis" });
    expect(await one(422, { code: "key_reused" })).toEqual({ state: "failed", code: "key_reused" });
    expect(await one(504, { code: "timeout" })).toEqual({ state: "failed", code: "timeout" });
  });

  it("retries a network error once", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(json(200, { ok: 1 }));
    expect((await requestAi("/x", {}, { requestId: "id-0000000000000004", fetchImpl })).state).toBe("done");
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    expect(await requestAi("/x", {}, { requestId: "id-0000000000000005", fetchImpl: down })).toEqual({ state: "offline", reason: "network" });
    expect(down).toHaveBeenCalledTimes(2);
  });

  it("makes exactly one new id when the old one can't be replayed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json(409, { code: "retry_new_key" })).mockResolvedValueOnce(json(200, { ok: 1 }));
    const ids: string[] = [];
    const out = await requestAiOnce("/x", {}, { requestId: "id-0000000000000006", fetchImpl, onNewId: (id) => ids.push(id) });
    expect(out.state).toBe("done");
    expect(ids).toHaveLength(1);
    expect(JSON.parse(String((fetchImpl.mock.calls[1][1] as RequestInit).body)).requestId).toBe(ids[0]);
  });
});

describe("visitor confirmed before any AI request", () => {
  const VISITOR = "/api/ai/visitor";
  /** A transport that answers the visitor pre-call with `prep` (a status, or "lost") and AI calls with 200. */
  function transport(prep: () => number | "lost" | "hang") {
    const urls: string[] = [];
    const ids: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      urls.push(String(url));
      if (String(url) === VISITOR) {
        const p = prep();
        if (p === "lost") throw new TypeError("lost response");
        if (p === "hang") return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
        return p === 204 ? new Response(null, { status: 204 }) : json(p, { code: p === 503 ? "ledger" : "visitor_cap" });
      }
      ids.push(JSON.parse(String(init?.body)).requestId);
      return json(200, { ok: 1 });
    });
    const count = () => ({ visitor: urls.filter((u) => u === VISITOR).length, ai: urls.filter((u) => u !== VISITOR).length });
    return { fetchImpl, count, ids };
  }

  it("prepares once, before any AI request, shared by concurrent first requests", async () => {
    resetVisitorForTests();
    const t = transport(() => 204);
    await Promise.all([1, 2, 3].map((i) => requestAi("/api/ai/tarot", {}, { requestId: `id-00000000000000a${i}`, fetchImpl: t.fetchImpl })));
    expect(t.count()).toEqual({ visitor: 1, ai: 3 });
    expect(t.fetchImpl.mock.calls[0][0]).toBe(VISITOR);
    await requestAi("/api/ai/tarot", {}, { requestId: "id-00000000000000a4", fetchImpl: t.fetchImpl });
    expect(t.count()).toEqual({ visitor: 1, ai: 4 });
  });

  it("sends nothing billable when the visitor can't be confirmed, and prepares again later", async () => {
    resetVisitorForTests();
    let answer: number | "lost" = 503;
    const t = transport(() => answer);
    expect(await requestAi("/api/ai/talk", {}, { requestId: "id-00000000000000b1", fetchImpl: t.fetchImpl })).toEqual({ state: "offline", reason: "ledger", code: "ledger" });
    answer = 429;
    expect(await requestAi("/api/ai/talk", {}, { requestId: "id-00000000000000b2", fetchImpl: t.fetchImpl })).toEqual({ state: "offline", reason: "busy" });
    answer = "lost";
    expect(await requestAi("/api/ai/talk", {}, { requestId: "id-00000000000000b3", fetchImpl: t.fetchImpl })).toEqual({ state: "offline", reason: "network" });
    expect(t.count()).toEqual({ visitor: 3, ai: 0 }); // no refusal was remembered as ready
    answer = 204;
    expect((await requestAi("/api/ai/talk", {}, { requestId: "id-00000000000000b4", fetchImpl: t.fetchImpl })).state).toBe("done");
    expect(t.count()).toEqual({ visitor: 4, ai: 1 });
  });

  it("concurrent first requests during a failed preparation all stop, then all recover", async () => {
    resetVisitorForTests();
    let answer: number = 503;
    const t = transport(() => answer);
    const first = await Promise.all([1, 2].map((i) => requestAi("/api/ai/talk", {}, { requestId: `id-00000000000000c${i}`, fetchImpl: t.fetchImpl })));
    expect(first.map((o) => o.state)).toEqual(["offline", "offline"]);
    expect(t.count()).toEqual({ visitor: 1, ai: 0 });
    answer = 204;
    const second = await Promise.all([1, 2].map((i) => requestAi("/api/ai/talk", {}, { requestId: `id-00000000000000c${i}`, fetchImpl: t.fetchImpl })));
    expect(second.map((o) => o.state)).toEqual(["done", "done"]);
    expect(t.count()).toEqual({ visitor: 2, ai: 2 });
  });

  it("keeps the same request id on a lost AI response once the visitor is confirmed", async () => {
    resetVisitorForTests();
    let lostOnce = true;
    const ids: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === VISITOR) return new Response(null, { status: 204 });
      ids.push(JSON.parse(String(init?.body)).requestId);
      if (lostOnce) { lostOnce = false; throw new TypeError("lost response"); }
      return json(200, { ok: 1, replayed: true });
    });
    expect((await requestAi("/api/ai/talk", {}, { requestId: "id-00000000000000d1", fetchImpl })).state).toBe("done");
    expect(ids).toEqual(["id-00000000000000d1", "id-00000000000000d1"]); // the server replays it for the same visitor
  });

  it("bounds the preparation with a timeout, and lets a caller cancel its wait", async () => {
    vi.useFakeTimers();
    resetVisitorForTests();
    const t = transport(() => "hang");
    const pending = requestAi("/api/ai/talk", {}, { requestId: "id-00000000000000e1", fetchImpl: t.fetchImpl });
    await vi.advanceTimersByTimeAsync(VISITOR_PREPARE_TIMEOUT_MS + 10);
    expect(await pending).toEqual({ state: "offline", reason: "network" });
    expect(t.count().ai).toBe(0);

    resetVisitorForTests();
    const ctrl = new AbortController();
    const other = requestAi("/api/ai/talk", {}, { requestId: "id-00000000000000e2", fetchImpl: t.fetchImpl });
    const mine = requestAi("/api/ai/talk", {}, { requestId: "id-00000000000000e3", fetchImpl: t.fetchImpl, signal: ctrl.signal });
    ctrl.abort(new Error("left the page"));
    await expect(mine).rejects.toThrow("left the page");
    await vi.advanceTimersByTimeAsync(VISITOR_PREPARE_TIMEOUT_MS + 10);
    expect(await other).toEqual({ state: "offline", reason: "network" }); // the shared attempt carried on for the other caller
    expect(t.count().ai).toBe(0);
  });

  it("confirms a freshly minted visitor once more, and skips the same-id retry if the browser drops the cookie", async () => {
    resetVisitorForTests();
    const answers = ["new", "known"];
    let aiCalls = 0;
    const kept = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === VISITOR) return new Response(null, { status: 204, headers: { "x-moona-visitor": answers.shift() ?? "known" } });
      aiCalls++;
      if (aiCalls === 1) throw new TypeError("lost response");
      return json(200, { ok: 1 });
    });
    expect((await requestAi("/api/ai/talk", {}, { requestId: "id-00000000000000f1", fetchImpl: kept })).state).toBe("done");
    expect(kept.mock.calls.filter((c) => String(c[0]) === VISITOR)).toHaveLength(2);
    expect(aiCalls).toBe(2); // the cookie stuck: the same id was safely sent again

    resetVisitorForTests();
    aiCalls = 0;
    const dropped = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === VISITOR) return new Response(null, { status: 204, headers: { "x-moona-visitor": "new" } }); // never "known": cookies are not kept
      aiCalls++;
      throw new TypeError("lost response");
    });
    expect(await requestAi("/api/ai/talk", {}, { requestId: "id-00000000000000f2", fetchImpl: dropped })).toEqual({ state: "offline", reason: "network" });
    expect(aiCalls).toBe(1); // no automatic second run as another visitor
  });

  it("is bounded even when the transport ignores the abort signal", async () => {
    vi.useFakeTimers();
    resetVisitorForTests();
    const deaf = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)); // never settles, ignores signals
    const pending = requestAi("/api/ai/talk", {}, { requestId: "id-00000000000000f3", fetchImpl: deaf });
    await vi.advanceTimersByTimeAsync(VISITOR_PREPARE_TIMEOUT_MS + 10);
    expect(await pending).toEqual({ state: "offline", reason: "network" });
    // the next request prepares again rather than joining the stuck attempt
    const again = requestAi("/api/ai/talk", {}, { requestId: "id-00000000000000f4", fetchImpl: deaf });
    await vi.advanceTimersByTimeAsync(VISITOR_PREPARE_TIMEOUT_MS + 10);
    expect(await again).toEqual({ state: "offline", reason: "network" });
    expect(deaf).toHaveBeenCalledTimes(2);
  });

  it("makes one new id when the saved one now describes a different request (422)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json(422, { code: "key_reused" })).mockResolvedValueOnce(json(200, { ok: 1 }));
    const ids: string[] = [];
    expect((await requestAiOnce("/x", {}, { requestId: "id-0000000000000007", fetchImpl, onNewId: (id) => ids.push(id) })).state).toBe("done");
    expect(ids).toHaveLength(1);
  });
});

describe("newRequestId", () => {
  it("is 22 base64url characters, even without crypto.randomUUID", () => {
    const original = crypto.randomUUID;
    try {
      Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
      const id = newRequestId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(newRequestId()).not.toBe(id);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });
});
