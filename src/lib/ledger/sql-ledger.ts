// The shared ledger on Postgres (spec §3.3). Each method is exactly one call of one PL/pgSQL function
// (`select moona.<fn>($1::jsonb)`), which takes the global row lock first, so every money and
// entitlement change is atomic across all server instances. Connection-level failures become
// LedgerUnavailable (callers then stop new paid requests); anything else is a bug and is rethrown.
import "server-only";
import type { SqlExecutor } from "./drivers";
import {
  LedgerUnavailable,
  type AdminLedger, type AuditRow, type CompleteOutcome, type EntitlementView, type FailOutcome, type FulfilOutcome, type LedgerSnapshot,
  type OrderOutcome, type OrderView, type PoolView, type RequestView, type ReserveOutcome, type SyncPlanPayload,
} from "./port";

const FUNCTIONS = new Set([
  "reserve", "complete", "fail", "mint_visitor", "ensure_account", "entitlements", "create_order", "attach_session", "view_order",
  "orders_to_verify", "fulfil", "expire_order", "revoke_order", "reap", "purge_results", "snapshot", "audit", "set_flag",
  "sync_plan", "record_spend", "revoke_mode",
]);

type J = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : 0);
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : num(v));
// Timestamps come back in the session time zone; the contract is UTC ISO strings.
const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(String(v)).toISOString());

const UNAVAILABLE_CODES = /^(08|53300|55P03|57014|57P01|57P03)/;
const NETWORK_ERRORS = new Set([
  "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "EPIPE", "EAI_AGAIN",
  // TLS: a database we can't verify is a database we can't use
  "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function classify(e: unknown): never {
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && (UNAVAILABLE_CODES.test(code) || NETWORK_ERRORS.has(code))) throw new LedgerUnavailable("ledger_down", (e as Error).message);
  // Only an error without a code is judged by its message (pg's own timeouts and closed connections);
  // a database error always has a code, and its message may echo client-supplied values.
  const msg = (e as Error).message ?? "";
  if (code === undefined && /timeout|terminat|Connection|connect/i.test(msg) && !/moona:/.test(msg)) throw new LedgerUnavailable("ledger_down", msg);
  throw e;
}

// jsonb can't hold U+0000 or an unpaired surrogate. Neither is ever meaningful in a reply, so each
// string is cleaned before it is serialised (a regex on the serialised text could cut an escape apart).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function jsonSafe(_key: string, v: unknown): unknown {
  return typeof v === "string" ? v.replace(/\u0000/g, "").replace(LONE_SURROGATE, "�") : v;
}

export function requestView(j: J): RequestView {
  return {
    id: String(j.id),
    state: j.state as RequestView["state"],
    mode: j.mode as RequestView["mode"],
    purpose: j.purpose as RequestView["purpose"],
    errorCode: str(j.error_code),
    result: (j.result ?? null) as RequestView["result"],
    paidReadingId: str(j.paid_reading_id),
    followupsLeft: numOrNull(j.followups_left),
  };
}

export function orderView(j: J): OrderView {
  return {
    id: String(j.id),
    state: j.state as OrderView["state"],
    mode: j.mode as OrderView["mode"],
    holds: !!j.holds,
    amountCents: num(j.amount_cents),
    currency: String(j.currency),
    readings: num(j.readings),
    followupsPerReading: num(j.followups_per_reading),
    checkoutExpiresAt: iso(j.checkout_expires_at)!,
    sessionId: str(j.provider_session_id),
    checkoutUrl: str(j.checkout_url),
    reviewNote: str(j.review_note),
    creditsLeft: numOrNull(j.credits_left),
    lotState: str(j.lot_state),
    createdAt: iso(j.created_at)!,
    paidAt: iso(j.paid_at),
  };
}

function poolView(j: J): PoolView {
  return {
    id: String(j.id), kind: String(j.kind), parentId: str(j.parent_id), capMicro: num(j.cap_micro), spentMicro: num(j.spent_micro), heldMicro: num(j.held_micro),
    overrunMicro: num(j.overrun_micro), callsCap: numOrNull(j.calls_cap), callsUsed: num(j.calls_used), startsAt: iso(j.starts_at), endsAt: iso(j.ends_at),
  };
}

export function createSqlLedger(exec: SqlExecutor, o: { clock?: () => Date } = {}): AdminLedger {
  const call = async (fn: string, payload: J = {}): Promise<J> => {
    if (!FUNCTIONS.has(fn)) throw new Error(`moona: unknown ledger function ${fn}`);
    const body = o.clock ? { ...payload, now: o.clock().toISOString() } : payload;
    try {
      const r = await exec.query<{ r: unknown }>(`select moona.${fn}($1::jsonb) as r`, [JSON.stringify(body, jsonSafe)]);
      return (r.rows[0]?.r ?? null) as J;
    } catch (e) {
      return classify(e);
    }
  };
  const callAny = async (fn: string, payload: J = {}): Promise<unknown> => (await call(fn, payload)) as unknown;

  return {
    kind: "sql",
    supportsPaid: true,

    async reserve(r): Promise<ReserveOutcome> {
      const j = await call("reserve", {
        idem_key: r.idemKey, subject_key: r.subjectKey, account_id: r.accountId ?? null, cache_scope: r.cacheScope, purpose: r.purpose, mode: r.mode,
        input_hash: r.inputHash, bound_micro: r.boundMicro, quota_exempt: !!r.quotaExempt, paid_reading_id: r.paidReadingId ?? null, reading_hash: r.readingHash ?? null,
        replay_only: !!r.replayOnly, draw_key: r.drawKey ?? null,
      });
      switch (j.status) {
        case "reserved": return { status: "reserved", requestId: String(j.request_id), leaseExpiresAt: iso(j.lease_expires_at)! };
        case "existing": case "cached": return { status: j.status, request: requestView(j.request as J) };
        case "in_progress": return { status: "in_progress", requestId: String(j.request_id) };
        default: return { status: "denied", reason: j.reason as never, ...(j.retry_after_s !== undefined ? { retryAfterS: num(j.retry_after_s) } : {}) };
      }
    },

    async complete(r): Promise<CompleteOutcome> {
      const j = await call("complete", {
        request_id: r.requestId, charged_micro: r.chargedMicro, billing: r.billing, usage: r.usage, result: r.result, result_ttl_seconds: r.resultTtlSeconds, reading_hash: r.readingHash ?? null,
      });
      if (j.status === "succeeded" || j.status === "already") return { status: j.status, request: requestView(j.request as J), ...(j.overrun_micro !== undefined ? { overrunMicro: num(j.overrun_micro) } : {}), ...(j.budget_ratio !== undefined && j.budget_ratio !== null ? { budgetRatio: num(j.budget_ratio) } : {}) };
      return { status: j.status as "late" | "conflict" };
    },

    async fail(r): Promise<FailOutcome> {
      const j = await call("fail", {
        request_id: r.requestId, billing: r.billing, charged_micro: r.chargedMicro ?? null, usage: r.usage, error_code: r.errorCode, rate_limited: !!r.rateLimited, retry_after_s: r.retryAfterS ?? 0,
      });
      if (j.status === "failed") return { status: "failed", chargedMicro: num(j.charged_micro), overrunMicro: num(j.overrun_micro) };
      return { status: j.status as "already" | "late" };
    },

    async mintVisitor(netBucket) {
      const j = await call("mint_visitor", { net_bucket: netBucket });
      return j.status === "ok" ? { ok: true } : { ok: false, reason: j.reason as "mint_cap" | "mint_net" | "plan_unsynced" };
    },

    async snapshot(): Promise<LedgerSnapshot> {
      const j = await call("snapshot");
      const g = (j.gate ?? {}) as J;
      const plan = (j.plan ?? null) as J | null;
      const sold = (j.sold ?? {}) as J;
      return {
        kind: "sql",
        planId: plan ? str(plan.plan_id) : null,
        planHash: plan ? str(plan.plan_hash) : null,
        pools: ((j.pools ?? []) as J[]).map(poolView),
        activeWindowId: str(j.active_window),
        gate: { inflight: num(g.inflight), breaker: g.breaker as "ok" | "tripped", breakerReason: str(g.breaker_reason), sales: g.sales as "open" | "closed", salesReason: str(g.sales_reason), cooldownUntil: iso(g.cooldown_until) },
        sold: { test: num(sold.test), live: num(sold.live) },
        owedReadings: num(j.owed_readings),
        reviewOrders: num(j.review_orders),
      };
    },

    async reap(limit) {
      return num((await call("reap", limit ? { limit } : {})).reaped);
    },
    async purgeResults() {
      return num((await call("purge_results")).purged);
    },
    async audit(): Promise<AuditRow[]> {
      return ((await callAny("audit")) as J[]).map((x) => ({ check: String(x.check), subject: String(x.subject), expected: num(x.expected), actual: num(x.actual) }));
    },
    async setFlag(key, value, reason) {
      await call("set_flag", { key, value, reason });
    },

    async ensureAccount(provider, subject) {
      return String((await call("ensure_account", { provider, subject })).account_id);
    },
    async entitlements(accountId): Promise<EntitlementView> {
      const j = await call("entitlements", { account_id: accountId });
      return {
        credits: num(j.credits),
        readings: ((j.readings ?? []) as J[]).map((x) => ({ paidReadingId: String(x.paid_reading_id), followupsLeft: num(x.followups_left), lotOpen: !!x.lot_open })),
        orders: ((j.orders ?? []) as J[]).map(orderView),
        unservable: !!j.unservable,
      };
    },
    async createOrder(r): Promise<OrderOutcome> {
      const j = await call("create_order", { account_id: r.accountId, product_id: r.productId, mode: r.mode, checkout_key: r.checkoutKey });
      if (j.status === "denied") return { status: "denied", reason: j.reason as never };
      return { status: j.status as "created" | "existing" | "pending_exists", order: orderView(j.order as J) };
    },
    async attachSession(r) {
      return (await call("attach_session", { order_id: r.orderId, session_id: r.sessionId, url: r.url })).status as "attached" | "not_pending";
    },
    async viewOrder(orderId, accountId) {
      const j = await callAny("view_order", { order_id: orderId, account_id: accountId });
      return j ? orderView(j as J) : null;
    },
    async ordersToVerify(limit) {
      return ((await callAny("orders_to_verify", limit ? { limit } : {})) as J[]).map(orderView);
    },
    async fulfil(e): Promise<FulfilOutcome> {
      return (await call("fulfil", {
        event_id: e.eventId, type: e.type, order_id: e.orderId, session_id: e.sessionId, payment_id: e.paymentId, amount_cents: e.amountCents, currency: e.currency, livemode: e.livemode, paid: e.paid,
      })).status as FulfilOutcome;
    },
    async expireOrder(e) {
      return String((await call("expire_order", { event_id: e.eventId, session_id: e.sessionId, kind: e.kind })).status);
    },
    async revokeOrder(e) {
      return String((await call("revoke_order", { event_id: e.eventId, kind: e.kind, payment_id: e.paymentId ?? null, order_id: e.orderId ?? null })).status);
    },

    async syncPlan(p: SyncPlanPayload) {
      await call("sync_plan", p as unknown as J);
    },
    async recordSpend(e) {
      return (await call("record_spend", { entry_id: e.entryId, pools: e.pools, amount_micro: e.amountMicro, kind: e.kind, note: e.note })).status as "recorded" | "duplicate";
    },
    async revokeMode() {
      return num((await call("revoke_mode")).orders);
    },
  };
}
