// One metered AI request on the shared ledger (spec §3.1 meter, §9 flow A):
//   reserve the request's bound → call the provider exactly once → complete (or fail) with what was
//   actually billed. No provider call happens unless the ledger said "reserved"; a ledger error on
//   reserve fails closed. The same client request id replays the saved result for free, and an
//   identical request already running is joined rather than paid twice.
// If the ledger is briefly unreachable after the call, settling is retried; if it stays down the
// result is still returned and the lease reaper later charges the bound (never less than the truth).
import "server-only";
import { modelCaps } from "./capabilities";
import type { AiConfig } from "./config";
import { requestBoundMicro } from "./pricing";
import { callProvider, chargeMicro, parseReply, sizeRequest } from "./provider";
import { AiError, type JsonRequest, type PublicMeta, type Purpose } from "./types";
import type { Keys } from "@/lib/identity/keys";
import { idemKey, inputHash } from "@/lib/ledger/hash";
import { LedgerUnavailable, type Billing, type DenyReason, type LedgerPort, type ReqMode, type RequestView, type StoredResult } from "@/lib/ledger/port";

export interface MeterInput<T> {
  ledger: LedgerPort;
  cfg: AiConfig;
  keys: Keys;
  subjectKey: string;
  accountId?: string;
  quotaExempt?: boolean;
  purpose: Purpose;
  mode: ReqMode;
  requestId: string;
  req: JsonRequest;
  /** The parsed request, as hashed for replay and caching (never stored in readable form). */
  canonical: unknown;
  versions: string;
  validate: (d: unknown) => T | null;
  cacheScope: "subject" | "shared";
  resultTtlSeconds: number;
  paid?: { readingHash: string; paidReadingId?: string; drawKey?: string };
  /** Paid only: fetch the answer to this subject's earlier request with this id; never start one. */
  replayOnly?: boolean;
}

export type MeterOutcome<T> =
  | { kind: "fresh" | "replayed"; value: T; meta: PublicMeta; paidReadingId?: string; followupsLeft?: number; budgetRatio?: number }
  | { kind: "in_progress"; retryAfterMs: number }
  | { kind: "denied"; reason: DenyReason; retryAfterS?: number }
  | { kind: "retry_new_key" }
  | { kind: "unavailable" }
  | { kind: "failed"; error: AiError };

export interface MeterDeps {
  call?: typeof callProvider;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const SETTLE_RETRIES_MS = [100, 400, 1200];
const IN_PROGRESS_RETRY_MS = 2000;

async function settleWithRetry<R>(fn: () => Promise<R>, sleep: (ms: number) => Promise<void>): Promise<R | null> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof LedgerUnavailable) || i >= SETTLE_RETRIES_MS.length) {
        if (e instanceof LedgerUnavailable) return null; // the reaper charges the bound later
        throw e;
      }
      await sleep(SETTLE_RETRIES_MS[i]);
    }
  }
}

function replay<T>(r: RequestView): MeterOutcome<T> {
  if (r.state === "calling") return { kind: "in_progress", retryAfterMs: IN_PROGRESS_RETRY_MS };
  if (!r.result || r.state === "failed") return { kind: "retry_new_key" }; // failed, or its text expired
  return {
    kind: "replayed", value: r.result.value as T, meta: r.result.meta,
    ...(r.paidReadingId ? { paidReadingId: r.paidReadingId } : {}), ...(r.followupsLeft !== null ? { followupsLeft: r.followupsLeft } : {}),
  };
}

export async function meteredGenerate<T>(a: MeterInput<T>, deps: MeterDeps = {}): Promise<MeterOutcome<T>> {
  const call = deps.call ?? callProvider;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const { ledger, cfg, keys } = a;
  // a paid request is always tied to its reading; without that the ledger can't check or record it
  if (a.mode !== "free" && !a.paid?.readingHash) throw new Error("moona: a paid request needs its reading hash");
  if (a.mode === "paid_reading" && !a.paid?.drawKey) throw new Error("moona: a pack reading needs its draw key");

  const sized = sizeRequest(a.req, cfg);
  const boundMicro = requestBoundMicro(sized, cfg, sized.maxOutputTokens!);
  const hash = inputHash(keys.input, { purpose: a.purpose, versions: a.versions, provider: cfg.provider, model: cfg.model, maxOutput: sized.maxOutputTokens, mode: a.mode, parsed: a.canonical });

  let reserved;
  try {
    reserved = await ledger.reserve({
      idemKey: idemKey(keys.input, a.subjectKey, a.purpose, a.requestId), subjectKey: a.subjectKey, accountId: a.accountId,
      cacheScope: a.cacheScope === "shared" ? "shared" : a.subjectKey, purpose: a.purpose, mode: a.mode, inputHash: hash, boundMicro,
      quotaExempt: a.quotaExempt, paidReadingId: a.paid?.paidReadingId, readingHash: a.paid?.readingHash, drawKey: a.paid?.drawKey,
      replayOnly: a.mode !== "free" && !!a.replayOnly,
    });
  } catch (e) {
    if (e instanceof LedgerUnavailable) return { kind: "unavailable" };
    throw e;
  }
  if (reserved.status === "in_progress") return { kind: "in_progress", retryAfterMs: IN_PROGRESS_RETRY_MS };
  if (reserved.status === "denied") return { kind: "denied", reason: reserved.reason, ...(reserved.retryAfterS !== undefined ? { retryAfterS: reserved.retryAfterS } : {}) };
  if (reserved.status !== "reserved") return replay<T>(reserved.request); // existing or cached: free
  const requestId = reserved.requestId;

  const fail = async (error: AiError, billing: Billing, chargedMicro?: number): Promise<MeterOutcome<T>> => {
    await settleWithRetry(() => ledger.fail({
      requestId, billing, chargedMicro, usage: error.usage ?? null, errorCode: error.code, rateLimited: error.rateLimited, retryAfterS: error.retryAfterS,
    }), sleep);
    return { kind: "failed", error };
  };

  let result;
  try {
    result = await call(sized, cfg);
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError("upstream", "provider call failed");
    if (err.billing === "known" && err.usage) return fail(err, "known", chargeMicro(err.usage, cfg, boundMicro));
    return fail(err, err.billing === "none" ? "none" : "unknown");
  }
  const chargedMicro = chargeMicro(result.usage, cfg, boundMicro);
  const billing = result.usage.complete && result.usage.attempts.length ? "known" : "bound";

  let value: T | null;
  try {
    value = a.validate(parseReply(result.text, modelCaps(cfg.provider, cfg.model)));
  } catch {
    value = null;
  }
  if (value === null) return fail(new AiError("bad_output", "reply failed validation", { usage: result.usage }), "known", chargedMicro);

  const meta: PublicMeta = { provider: cfg.provider, model: result.model, generatedAt: now().toISOString(), source: cfg.provider === "fake" ? "simulated" : "live" };
  const stored: StoredResult = { value, meta };
  let done;
  try {
    done = await settleWithRetry(() => ledger.complete({
      requestId, chargedMicro, billing, usage: result.usage, result: stored, resultTtlSeconds: a.resultTtlSeconds, readingHash: a.mode === "paid_reading" ? a.paid?.readingHash : undefined,
    }), sleep);
  } catch {
    // The ledger refused the reply itself (it could not be stored): settle what was billed now,
    // give the entitlement back, and answer as an unusable reply rather than leaving it to the reaper.
    return fail(new AiError("bad_output", "reply could not be stored", { usage: result.usage }), "known", chargedMicro);
  }
  const view = done && done.status !== "late" && done.status !== "conflict" ? done : null;
  return {
    kind: "fresh", value, meta,
    ...(view?.request.paidReadingId ? { paidReadingId: view.request.paidReadingId } : {}),
    ...(view && view.request.followupsLeft !== null ? { followupsLeft: view.request.followupsLeft } : {}),
    ...(view?.budgetRatio !== undefined ? { budgetRatio: view.budgetRatio } : {}),
  };
}
