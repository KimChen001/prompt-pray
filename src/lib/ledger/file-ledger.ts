// The legacy JSON-file budget behind the ledger contract (spec §3.3 file-ledger), for local,
// single-process development only: free mode, no idempotency, result cache or per-visitor quotas.
// The factory never offers it on a serverless host. Paid methods throw LedgerUnsupported.
import "server-only";
import { randomUUID } from "node:crypto";
import { AiError } from "@/lib/ai/types";
import type { Budget, BudgetDenial, BudgetReservation } from "@/lib/ai/budget";
import { LedgerUnavailable, LedgerUnsupported, type DenyReason, type LedgerPort, type ReqMode, type RequestView } from "./port";
import type { Purpose } from "@/lib/ai/types";

const DENIAL: Record<BudgetDenial, DenyReason> = { daily_calls: "window_calls", daily_usd: "window_usd", total_usd: "total_usd" };

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AiError && e.code === "budget") throw new LedgerUnavailable("ledger_down", e.message);
    throw e;
  }
}

export function createFileLedger(budget: Budget, o: { leaseSeconds?: number; now?: () => Date } = {}): LedgerPort {
  const open = new Map<string, { reservation: BudgetReservation; purpose: Purpose; mode: ReqMode }>();
  const now = o.now ?? (() => new Date());
  const unsupported = () => Promise.reject(new LedgerUnsupported("the file ledger is free mode only"));
  const view = (id: string, purpose: Purpose, mode: ReqMode, state: RequestView["state"], result: RequestView["result"], errorCode: string | null): RequestView =>
    ({ id, state, mode, purpose, errorCode, result, paidReadingId: null, followupsLeft: null });

  return {
    kind: "file",
    supportsPaid: false,

    async reserve(r) {
      if (r.mode !== "free") return unsupported();
      const res = await guarded(() => budget.reserveRequest(r.boundMicro / 1e6));
      if (typeof res === "string") return { status: "denied", reason: DENIAL[res] };
      const requestId = randomUUID();
      open.set(requestId, { reservation: res, purpose: r.purpose, mode: r.mode });
      return { status: "reserved", requestId, leaseExpiresAt: new Date(now().getTime() + (o.leaseSeconds ?? 120) * 1000).toISOString() };
    },

    async complete(r) {
      const held = open.get(r.requestId);
      if (!held) return { status: "late" };
      open.delete(r.requestId);
      await guarded(() => budget.settle(held.reservation, r.chargedMicro / 1e6));
      return { status: "succeeded", request: view(r.requestId, held.purpose, held.mode, "succeeded", r.result, null) };
    },

    async fail(r) {
      const held = open.get(r.requestId);
      if (!held) return { status: "late" };
      open.delete(r.requestId);
      // Unknown or bound billing keeps the whole hold (fail closed); the provider may have charged it.
      if (r.billing === "none") await guarded(() => budget.settle(held.reservation, 0));
      else if (r.billing === "known") await guarded(() => budget.settle(held.reservation, (r.chargedMicro ?? 0) / 1e6));
      return { status: "failed", chargedMicro: r.billing === "known" ? r.chargedMicro ?? 0 : r.billing === "none" ? 0 : Math.round(held.reservation.usd * 1e6), overrunMicro: 0 };
    },

    async mintVisitor() {
      return { ok: true };
    },
    async snapshot() {
      return { kind: "file", legacy: await guarded(() => budget.snapshot()) };
    },
    async reap() {
      return 0;
    },
    async purgeResults() {
      return 0;
    },
    async audit() {
      return [];
    },
    setFlag: unsupported,
    ensureAccount: unsupported,
    entitlements: unsupported,
    createOrder: unsupported,
    attachSession: unsupported,
    viewOrder: unsupported,
    ordersToVerify: unsupported,
    fulfil: unsupported,
    expireOrder: unsupported,
    revokeOrder: unsupported,
  };
}
