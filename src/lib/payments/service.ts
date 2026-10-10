// Reading packs end to end (spec §3.4 service, §9 flows B–D). The ledger is the only source of truth:
// a redirect back from checkout never grants anything; credits appear only after a verified webhook
// or a verified retrieve says the session is complete and paid, and each event is applied once.
import "server-only";
import type { PaymentsConfig, PaymentsState } from "./config";
import { createFakePayments, type WebhookSink } from "./fake";
import { PaymentProviderError, WebhookSignatureError, type NormalizedPaymentEvent, type PaymentsPort } from "./port";
import { createStripePayments, type StripeLike } from "./stripe";
import { LedgerUnavailable, type AuditRow, type LedgerPort, type LedgerSnapshot, type OrderView } from "@/lib/ledger/port";
import type { ProductPlan } from "@/lib/ledger/plans";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidOrNull = (v: string | null) => (v && UUID.test(v) ? v : null);

export function paymentsFromConfig(cfg: PaymentsConfig, deps: { stripe?: StripeLike; sink?: WebhookSink } = {}): PaymentsPort | null {
  if (cfg.state === "fake") return createFakePayments(cfg, deps.sink);
  if (cfg.state === "test" || cfg.state === "live") return createStripePayments(cfg, deps.stripe);
  // misconfigured for selling only: the provider port still verifies events and syncs existing orders
  if (cfg.state === "misconfigured" && cfg.webhookEnabled && cfg.webhookMode) return createStripePayments({ ...cfg, state: cfg.webhookMode }, deps.stripe);
  return null;
}

export async function startCheckout(c: { ledger: LedgerPort; pay: PaymentsPort; accountId: string; productId: string; checkoutKey: string; siteUrl: string; expected?: { amountCents: number; currency: string } }): Promise<{ url: string; orderId: string } | { denied: string }> {
  // The provider's price must be the pack's price, or every payment would end as amount_mismatch
  // (charged, nothing granted, a refund to make). Checked before anything is held.
  if (c.expected && c.pay.priceCheck) {
    const p = await c.pay.priceCheck();
    if (p.amountCents !== c.expected.amountCents || p.currency !== c.expected.currency.toLowerCase()) return { denied: "price_mismatch" };
  }
  const made = await c.ledger.createOrder({ accountId: c.accountId, productId: c.productId, mode: c.pay.state, checkoutKey: c.checkoutKey });
  if (made.status === "denied") return { denied: made.reason };
  const order = made.order;
  if (order.state !== "pending") return { denied: "order_closed" };
  if (order.checkoutUrl) return { url: order.checkoutUrl, orderId: order.id };
  // The holds are taken before any redirect; the url is released only once the session is attached,
  // so a webhook can never arrive for a session the ledger doesn't know.
  const session = await c.pay.createCheckout({
    orderId: order.id, checkoutExpiresAt: new Date(order.checkoutExpiresAt), amountCents: order.amountCents, currency: order.currency,
    successUrl: `${c.siteUrl}/me?order=${order.id}#packs`, cancelUrl: `${c.siteUrl}/me#packs`,
  });
  const attached = await c.ledger.attachSession({ orderId: order.id, sessionId: session.sessionId, url: session.url });
  if (attached === "not_pending") {
    await c.pay.expire(session.sessionId).catch(() => undefined);
    return { denied: "order_closed" };
  }
  return { url: session.url, orderId: order.id };
}

export async function handlePaymentEvent(ledger: LedgerPort, e: NormalizedPaymentEvent): Promise<string> {
  switch (e.kind) {
    case "paid":
    case "unpaid":
      return ledger.fulfil({ eventId: e.id, type: e.kind, orderId: uuidOrNull(e.orderId), sessionId: e.sessionId, paymentId: e.paymentId, amountCents: e.amountCents, currency: e.currency, livemode: e.livemode, paid: e.kind === "paid" });
    case "expired":
    case "async_failed":
      return ledger.expireOrder({ eventId: e.id, sessionId: e.sessionId, kind: e.kind });
    case "refund_full":
    case "refund_partial":
    case "dispute":
      return ledger.revokeOrder({ eventId: e.id, kind: e.kind, paymentId: e.paymentId, orderId: uuidOrNull(e.orderId) });
    case "ignored":
      return "ignored";
  }
}

/** The webhook route's whole job; the route only reads the raw body (never re-serialised JSON). */
export async function handleWebhook(raw: string, signature: string | null, deps: { ledger: () => Promise<LedgerPort>; pay: PaymentsPort | null; cfg: PaymentsConfig }): Promise<{ status: 200 | 400 | 404 | 503 | 500; body: Record<string, unknown> }> {
  if (!deps.cfg.webhookEnabled || !deps.pay) return { status: 404, body: { code: "not_found" } };
  let event: NormalizedPaymentEvent;
  try {
    event = deps.pay.verifyWebhook(raw, signature);
  } catch (e) {
    if (e instanceof WebhookSignatureError) return { status: 400, body: { code: "bad_signature" } }; // nothing written
    return { status: 400, body: { code: "bad_event" } };
  }
  if (event.livemode !== (deps.pay.state === "live")) return { status: 400, body: { code: "livemode_mismatch" } };
  try {
    const ledger = await deps.ledger();
    return { status: 200, body: { received: true, outcome: await handlePaymentEvent(ledger, event) } };
  } catch (e) {
    if (e instanceof LedgerUnavailable) return { status: 503, body: { code: "ledger" } }; // the provider redelivers
    return { status: 500, body: { code: "error" } };
  }
}

async function syncSession(ledger: LedgerPort, pay: PaymentsPort, order: OrderView): Promise<boolean> {
  if (order.state !== "pending" || !order.sessionId) return false;
  let s;
  try {
    s = await pay.retrieve(order.sessionId);
  } catch (e) {
    if (e instanceof PaymentProviderError) return false; // unreachable: the hold stays
    throw e;
  }
  if (s.status === "complete" && s.paymentStatus === "paid") {
    await ledger.fulfil({ eventId: `sync:paid:${s.id}`, type: "sync", orderId: order.id, sessionId: s.id, paymentId: s.paymentIntentId, amountCents: s.amountTotal, currency: s.currency, livemode: s.livemode, paid: true });
    return true;
  }
  if (s.status === "expired") {
    await ledger.expireOrder({ eventId: `sync:expired:${s.id}`, sessionId: s.id, kind: "expired" });
    return true;
  }
  return false;
}

/** The return page's poll: asks the provider directly, so a webhook that is late can't strand a payment. */
export async function syncOrder(ledger: LedgerPort, pay: PaymentsPort | null, orderId: string, accountId: string): Promise<OrderView | null> {
  if (!UUID.test(orderId)) return null;
  const order = await ledger.viewOrder(orderId, accountId);
  if (!order) return null;
  if (pay && (await syncSession(ledger, pay, order))) return ledger.viewOrder(orderId, accountId);
  return order;
}

export async function reconcile(ledger: LedgerPort, pay: PaymentsPort | null): Promise<{ reaped: number; ordersSynced: number; purged: number; audit: AuditRow[] }> {
  const reaped = await ledger.reap();
  let ordersSynced = 0;
  if (pay && ledger.supportsPaid) for (const o of await ledger.ordersToVerify(50)) if (await syncSession(ledger, pay, o)) ordersSynced++;
  const purged = await ledger.purgeResults();
  const audit = await ledger.audit();
  if (audit.length) await ledger.setFlag("breaker", "tripped", `audit ${audit[0].check} ${audit[0].subject}`); // a counter disagrees with its rows: stop spending
  return { reaped, ordersSynced, purged, audit };
}

export type SalesReason = "unconfigured" | "misconfigured" | "operators_only" | "login_unavailable" | "ledger" | "paused" | "closed" | "no_pack_pool" | "sold_out" | "budget_short";

/** Whether packs can be bought right now, and the first reason when not (spec §7.3). */
export function salesState(cfg: PaymentsConfig, snap: LedgerSnapshot | null, ctx: { isOperator: boolean; deployed: boolean; authReady: boolean; product: ProductPlan; packSlackMicro: number }): { open: boolean; reason: SalesReason | null } {
  const no = (reason: SalesReason) => ({ open: false, reason });
  if (cfg.state === "unconfigured" || cfg.state === "misconfigured") return no(cfg.state);
  if ((cfg.state === "test" || cfg.state === "fake") && ctx.deployed && !ctx.isOperator) return no("operators_only");
  if (!ctx.authReady) return no("login_unavailable");
  if (!snap || snap.kind !== "sql") return no("ledger");
  if (snap.gate.breaker === "tripped") return no("paused");
  if (snap.gate.sales === "closed") return no("closed");
  const pool = (id: string) => snap.pools.find((p) => p.id === id);
  const packs = pool("packs"), ai = pool("ai"), reserve = pool("reserve");
  if (!packs || packs.capMicro <= 0) return no("no_pack_pool");
  const sold = cfg.state === "live" ? snap.sold.live : snap.sold.test;
  if (sold >= (cfg.state === "live" ? ctx.product.maxSoldLive : ctx.product.maxSoldTest)) return no("sold_out");
  const room = (p: typeof packs | undefined) => (p ? p.capMicro - p.spentMicro - p.heldMicro : 0);
  if (room(packs) < ctx.product.allocMicro + ctx.packSlackMicro || room(ai) < ctx.product.allocMicro || room(reserve) < ctx.product.feeHoldMicro) return no("budget_short");
  return { open: true, reason: null };
}

/** What the buy button may do (spec §10.3): real purchases only live and open; tests only for operators on a deployment. */
export function purchaseAction(state: PaymentsState, open: boolean, ctx: { isOperator: boolean; deployed: boolean }): null | { kind: "buy" | "test" | "simulate" } {
  if (!open) return null;
  if (state === "live") return { kind: "buy" };
  if ((state === "test" || state === "fake") && ctx.deployed && !ctx.isOperator) return null;
  if (state === "test") return { kind: "test" };
  if (state === "fake") return { kind: "simulate" };
  return null;
}
