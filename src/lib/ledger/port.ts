// The ledger contract (docs/ai-ledger-spec.md §3.3). Every money or entitlement change is one atomic
// call: the SQL ledger runs each as a single PL/pgSQL function under one global row lock; the file
// ledger is the legacy single-process budget for local development (free mode only).
import type { BudgetSnapshot } from "@/lib/ai/budget";
import type { NormalizedUsage, PublicMeta, Purpose } from "@/lib/ai/types";

export type ReqMode = "free" | "paid_reading" | "paid_followup";
export type Billing = "known" | "none" | "unknown" | "bound";
export type DenyReason =
  | "plan_unsynced" | "key_reused" | "paused" | "cooldown" | "busy" | "subject_busy" | "no_window" | "total_usd"
  | "window_usd" | "window_calls" | "slice_usd" | "purpose_closed" | "subject_quota" | "subject_failures" | "no_credits"
  | "no_such_reading" | "reading_mismatch" | "no_followups" | "lot_closed" | "paid_capacity" | "no_such_request";

export interface StoredResult {
  value: unknown;
  meta: PublicMeta;
}

export interface RequestView {
  id: string;
  state: "calling" | "succeeded" | "failed" | "expired";
  mode: ReqMode;
  purpose: Purpose;
  errorCode: string | null;
  result: StoredResult | null;
  paidReadingId: string | null;
  followupsLeft: number | null;
}

export interface ReserveRequest {
  idemKey: string; // hex
  subjectKey: string; // "v:<uuid>" (visitor) or "a:<uuid>" (account)
  accountId?: string;
  cacheScope: string; // = subjectKey, or "shared"
  purpose: Purpose;
  mode: ReqMode;
  inputHash: string; // hex
  boundMicro: number;
  quotaExempt?: boolean;
  paidReadingId?: string;
  readingHash?: string; // hex
  /** Paid only: return this subject's earlier request with this key, never create one (no_such_request). */
  replayOnly?: boolean;
}

export type ReserveOutcome =
  | { status: "reserved"; requestId: string; leaseExpiresAt: string }
  | { status: "existing" | "cached"; request: RequestView }
  | { status: "in_progress"; requestId: string }
  | { status: "denied"; reason: DenyReason; retryAfterS?: number };

export interface CompleteRequest {
  requestId: string;
  chargedMicro: number;
  billing: "known" | "bound";
  usage: NormalizedUsage | null;
  result: StoredResult;
  resultTtlSeconds: number;
  readingHash?: string;
}

export type CompleteOutcome =
  | { status: "succeeded" | "already"; request: RequestView; overrunMicro?: number; budgetRatio?: number }
  | { status: "late" }
  | { status: "conflict" };

export interface FailRequest {
  requestId: string;
  billing: Billing;
  chargedMicro?: number;
  usage: NormalizedUsage | null;
  errorCode: string;
  rateLimited?: boolean;
  retryAfterS?: number;
}

export type FailOutcome = { status: "failed"; chargedMicro: number; overrunMicro: number } | { status: "already" | "late" };

export type PayMode = "fake" | "test" | "live";

export interface OrderView {
  id: string;
  state: "pending" | "paid" | "expired" | "canceled" | "paid_unfunded" | "needs_review" | "revoked";
  mode: PayMode;
  holds: boolean;
  amountCents: number;
  currency: string;
  readings: number;
  followupsPerReading: number;
  checkoutExpiresAt: string;
  sessionId: string | null;
  checkoutUrl: string | null;
  reviewNote: string | null;
  creditsLeft: number | null;
  lotState: string | null;
  createdAt: string;
  paidAt: string | null;
}

export type OrderOutcome =
  | { status: "created" | "existing" | "pending_exists"; order: OrderView }
  | { status: "denied"; reason: "plan_unsynced" | "sales_closed" | "no_product" | "sold_out" | "budget_short" };

export interface FulfilRequest {
  eventId: string;
  type: string;
  orderId: string | null;
  sessionId: string;
  paymentId: string | null;
  amountCents: number | null;
  currency: string | null;
  livemode: boolean;
  paid: boolean;
}

export type FulfilOutcome = "duplicate_event" | "unknown_order" | "session_mismatch" | "mode_mismatch" | "not_paid" | "already" | "amount_mismatch" | "paid_unfunded" | "granted";

export interface EntitlementView {
  credits: number;
  readings: { paidReadingId: string; followupsLeft: number; lotOpen: boolean }[];
  orders: OrderView[];
  unservable: boolean;
}

export interface PoolView {
  id: string;
  kind: string;
  parentId: string | null;
  capMicro: number;
  spentMicro: number;
  heldMicro: number;
  overrunMicro: number;
  callsCap: number | null;
  callsUsed: number;
  startsAt: string | null;
  endsAt: string | null;
}

export type LedgerSnapshot =
  | {
      kind: "sql";
      planId: string | null;
      planHash: string | null;
      pools: PoolView[];
      activeWindowId: string | null;
      gate: { inflight: number; breaker: "ok" | "tripped"; breakerReason: string | null; sales: "open" | "closed"; salesReason: string | null; cooldownUntil: string | null };
      sold: { test: number; live: number };
      owedReadings: number;
      reviewOrders: number;
    }
  | { kind: "file"; legacy: BudgetSnapshot };

export interface AuditRow {
  check: string;
  subject: string;
  expected: number;
  actual: number;
}

export interface SyncPlanPayload {
  plan: Record<string, unknown>;
  pools: Record<string, unknown>[];
  quotas: Record<string, unknown>[];
  products: Record<string, unknown>[];
}

export interface LedgerPort {
  readonly kind: "sql" | "file";
  readonly supportsPaid: boolean;
  reserve(r: ReserveRequest): Promise<ReserveOutcome>;
  complete(r: CompleteRequest): Promise<CompleteOutcome>;
  fail(r: FailRequest): Promise<FailOutcome>;
  mintVisitor(netBucket: string): Promise<{ ok: true } | { ok: false; reason: "mint_cap" | "mint_net" | "plan_unsynced" }>;
  snapshot(): Promise<LedgerSnapshot>;
  reap(limit?: number): Promise<number>;
  purgeResults(): Promise<number>;
  audit(): Promise<AuditRow[]>;
  setFlag(key: "breaker" | "sales", value: "ok" | "tripped" | "open" | "closed", reason: string): Promise<void>;
  // paid (the file ledger throws LedgerUnsupported)
  ensureAccount(provider: string, subject: string): Promise<string>;
  entitlements(accountId: string): Promise<EntitlementView>;
  createOrder(r: { accountId: string; productId: string; mode: PayMode; checkoutKey: string }): Promise<OrderOutcome>;
  attachSession(r: { orderId: string; sessionId: string; url: string }): Promise<"attached" | "not_pending">;
  viewOrder(orderId: string, accountId: string): Promise<OrderView | null>;
  ordersToVerify(limit?: number): Promise<OrderView[]>;
  fulfil(e: FulfilRequest): Promise<FulfilOutcome>;
  expireOrder(e: { eventId: string; sessionId: string; kind: "expired" | "async_failed" }): Promise<string>;
  revokeOrder(e: { eventId: string; kind: "refund_full" | "refund_partial" | "dispute"; paymentId?: string | null; orderId?: string | null }): Promise<string>;
}

export interface AdminLedger extends LedgerPort {
  syncPlan(p: SyncPlanPayload): Promise<void>;
  recordSpend(e: { entryId: string; pools: string[]; amountMicro: number; kind: string; note: string }): Promise<"recorded" | "duplicate">;
  revokeMode(): Promise<number>;
}

export class LedgerUnavailable extends Error {
  constructor(public reason: "ledger_down" | "ledger_nondurable" | "plan_unsynced", message?: string) {
    super(message ?? reason);
  }
}

export class LedgerUnsupported extends Error {}
