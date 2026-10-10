// The browser request helper (spec §11 client): one request id per attempt, "still running" and
// "busy" retried with the same id and body, and every refusal mapped to an honest outcome.
import { afterEach, describe, expect, it, vi } from "vitest";
import { newRequestId, requestAi, requestAiOnce } from "@/lib/ai/client";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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
    expect(await one(503, { code: "budget" })).toEqual({ state: "offline", reason: "budget" });
    expect(await one(503, { code: "misconfigured" })).toEqual({ state: "offline", reason: "unconfigured" });
    expect(await one(503, { code: "ledger" })).toEqual({ state: "offline", reason: "ledger" });
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
