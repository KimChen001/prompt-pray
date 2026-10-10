// Browser side of a metered AI request (spec §3.1 client). Every request carries a client request id;
// the caller keeps it with the record it belongs to, so a retry, a double tap or a reload replays the
// saved result instead of paying again. "Still running" and "busy" answers are retried with the same
// id and body until maxWaitMs; any other refusal resolves to an outcome the page can show honestly.

export type BudgetLevel = "notice" | "warn" | "critical";
export type OfflineReason = "unconfigured" | "locked" | "ledger" | "budget" | "paused" | "busy" | "network" | "paid_capacity";

export type AiOutcome<T> =
  | { state: "done"; value: T; replayed: boolean; budgetLevel?: BudgetLevel; paid?: { paidReadingId: string; followupsLeft: number } }
  | { state: "crisis" }
  | { state: "quota"; credits: number | null }
  | { state: "no_credits" }
  | { state: "needs_login" }
  | { state: "retry" }
  | { state: "offline"; reason: OfflineReason }
  | { state: "failed"; code: string };

/** 16 random bytes, base64url (22 characters). Works without crypto.randomUUID. */
export function newRequestId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const OFFLINE: Record<string, OfflineReason> = {
  unconfigured: "unconfigured", misconfigured: "unconfigured", locked: "locked", ledger: "ledger", budget: "budget",
  paused: "paused", busy: "busy", cooldown: "busy", paid_capacity: "paid_capacity",
};

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

const delay = (ms: unknown) => {
  const base = typeof ms === "number" && ms > 0 ? ms : 2000;
  return Math.min(5000, Math.round(base * (0.7 + Math.random() * 0.6)));
};

export interface RequestAiOptions {
  requestId: string;
  signal?: AbortSignal;
  /** How long to keep retrying "in progress" and "busy" (default 45 s). */
  maxWaitMs?: number;
  fetchImpl?: typeof fetch;
}

// The visitor cookie is set before the first AI request of a page (see /api/ai/visitor). Without a
// confirmed visitor, a request that has to be sent again (a lost response, a double tap) could run as
// a second visitor and be paid twice, so no AI request is sent until this has succeeded once.
// Only success is kept; a refusal, a lost response or a timeout is answered as offline and tried again
// on the next request.
export const VISITOR_PREPARE_TIMEOUT_MS = 8000;
type NotDone = Exclude<AiOutcome<never>, { state: "done" }>;
type Prepared = { ok: true } | { ok: false; outcome: NotDone };
let visitorReady: Promise<Prepared> | null = null;

async function prepareOnce(doFetch: typeof fetch): Promise<Prepared> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("visitor preparation timed out")), VISITOR_PREPARE_TIMEOUT_MS);
  try {
    const res = await doFetch("/api/ai/visitor", { method: "POST", signal: ctrl.signal });
    if (res.ok) return { ok: true };
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const code = typeof json.code === "string" ? json.code : null;
    if (res.status === 503) return { ok: false, outcome: { state: "offline", reason: (code && OFFLINE[code]) || "unconfigured" } };
    if (res.status === 429) return { ok: false, outcome: { state: "offline", reason: "busy" } }; // too many new visitors from here right now
    return { ok: false, outcome: { state: "failed", code: code ?? `http_${res.status}` } };
  } catch {
    return { ok: false, outcome: { state: "offline", reason: "network" } };
  } finally {
    clearTimeout(timer);
  }
}

function prepareVisitor(doFetch: typeof fetch, signal?: AbortSignal): Promise<Prepared> {
  if (!visitorReady) {
    const attempt = prepareOnce(doFetch);
    visitorReady = attempt;
    // concurrent first requests share one attempt; only a success is remembered
    void attempt.then((r) => { if (!r.ok && visitorReady === attempt) visitorReady = null; });
  }
  const shared = visitorReady;
  if (!signal) return shared;
  // a caller that gives up stops waiting; the shared attempt carries on for the others
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void shared.then((r) => { signal.removeEventListener("abort", onAbort); resolve(r); });
  });
}

/** For tests: forget (or pretend) that this page already confirmed its visitor. */
export function resetVisitorForTests(ready = false): void {
  visitorReady = ready ? Promise.resolve({ ok: true }) : null;
}

export async function requestAi<T>(path: string, body: Record<string, unknown>, o: RequestAiOptions): Promise<AiOutcome<T>> {
  const doFetch = o.fetchImpl ?? fetch;
  const prepared = await prepareVisitor(doFetch, o.signal);
  if (!prepared.ok) return prepared.outcome;
  const started = Date.now();
  const maxWait = o.maxWaitMs ?? 45_000;
  const payload = JSON.stringify({ ...body, requestId: o.requestId });
  let networkRetried = false;
  for (;;) {
    let res: Response;
    try {
      res = await doFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, signal: o.signal });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      if (networkRetried) return { state: "offline", reason: "network" };
      networkRetried = true;
      continue;
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const code = typeof json.code === "string" ? json.code : null;
    const again = res.status === 202 || (res.status === 503 && (code === "busy" || code === "cooldown")) || (res.status === 429 && code === "subject_busy");
    if (again) {
      const ms = delay(json.retryAfterMs);
      if (Date.now() - started + ms > maxWait) return { state: "offline", reason: "busy" };
      await wait(ms, o.signal);
      continue;
    }
    if (res.ok) {
      if (code === "crisis") return { state: "crisis" };
      if (code) return { state: "failed", code };
      const level = json.budgetLevel === "notice" || json.budgetLevel === "warn" || json.budgetLevel === "critical" ? json.budgetLevel : undefined;
      const paid = typeof json.paidReadingId === "string" && typeof json.followupsLeft === "number" ? { paidReadingId: json.paidReadingId, followupsLeft: json.followupsLeft } : undefined;
      return { state: "done", value: json as T, replayed: json.replayed === true, ...(level ? { budgetLevel: level } : {}), ...(paid ? { paid } : {}) };
    }
    if (res.status === 409 && code === "retry_new_key") return { state: "retry" };
    if (res.status === 429 && code === "quota") return { state: "quota", credits: typeof json.credits === "number" ? json.credits : null };
    if (res.status === 402) return { state: "no_credits" };
    if (res.status === 401) return { state: "needs_login" };
    if (res.status === 503) return { state: "offline", reason: (code && OFFLINE[code]) || "unconfigured" };
    return { state: "failed", code: code ?? `http_${res.status}` };
  }
}

/**
 * One request, retried once with a new id when the old one can't be used again: its attempt failed
 * or expired (409), or what is being asked has changed since it was saved (422 key_reused, e.g. the
 * interpretation shown arrived, or the chosen context changed).
 */
export async function requestAiOnce<T>(path: string, body: Record<string, unknown>, o: RequestAiOptions & { onNewId?: (id: string) => void }): Promise<AiOutcome<T>> {
  const first = await requestAi<T>(path, body, o);
  if (first.state !== "retry" && !(first.state === "failed" && first.code === "key_reused")) return first;
  const id = newRequestId();
  o.onNewId?.(id);
  return requestAi<T>(path, body, { ...o, requestId: id });
}
