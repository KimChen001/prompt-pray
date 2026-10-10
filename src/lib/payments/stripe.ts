// Stripe Checkout behind the payments contract (spec §3.4). Test and live modes only; the keys come
// from the host's environment (the team sets them; this code never stores or prints one). Webhook
// signatures are checked with the SDK's own constructEvent on the raw body, offline.
import "server-only";
import Stripe from "stripe";
import type { PaymentsConfig } from "./config";
import { PaymentProviderError, WebhookSignatureError, type CheckoutSession, type NormalizedPaymentEvent, type PaymentsPort } from "./port";

/* eslint-disable @typescript-eslint/no-explicit-any -- Stripe objects are read defensively, field by field */
export interface StripeLike {
  checkout: { sessions: { create(p: object, o: { idempotencyKey: string }): Promise<any>; retrieve(id: string): Promise<any>; expire(id: string): Promise<any> } };
  webhooks: { constructEvent(raw: string, sig: string, secret: string): any; generateTestHeaderString(o: { payload: string; secret: string; timestamp?: number }): string };
}

let offline: StripeLike | null = null;
/** An SDK instance used only for signing and verifying webhooks; it never makes a network call. */
export function offlineStripe(): StripeLike {
  return (offline ??= new Stripe("sk_test_offline_signature_checks_only", { maxNetworkRetries: 0 }) as unknown as StripeLike);
}

const idOf = (v: any): string | null => (typeof v === "string" ? v : v && typeof v.id === "string" ? v.id : null);
const num = (v: any): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function normalizeStripeEvent(ev: { id: string; type: string; livemode: boolean; data: { object: any } }): NormalizedPaymentEvent {
  const o = ev.data?.object ?? {};
  const livemode = !!ev.livemode;
  const order = (): string | null => (typeof o.client_reference_id === "string" ? o.client_reference_id : typeof o.metadata?.order_id === "string" ? o.metadata.order_id : null);
  const paid = (kind: "paid" | "unpaid"): NormalizedPaymentEvent => ({
    id: ev.id, kind, orderId: order(), sessionId: String(o.id ?? ""), paymentId: idOf(o.payment_intent), amountCents: num(o.amount_total), currency: typeof o.currency === "string" ? o.currency.toLowerCase() : null, livemode,
  });
  switch (ev.type) {
    case "checkout.session.completed": return paid(o.payment_status === "paid" ? "paid" : "unpaid");
    case "checkout.session.async_payment_succeeded": return paid("paid");
    case "checkout.session.async_payment_failed": return { id: ev.id, kind: "async_failed", sessionId: String(o.id ?? ""), livemode };
    case "checkout.session.expired": return { id: ev.id, kind: "expired", sessionId: String(o.id ?? ""), livemode };
    case "charge.refunded": {
      const full = num(o.amount_refunded) !== null && num(o.amount) !== null && o.amount_refunded >= o.amount;
      return { id: ev.id, kind: full ? "refund_full" : "refund_partial", paymentId: idOf(o.payment_intent), orderId: typeof o.metadata?.order_id === "string" ? o.metadata.order_id : null, livemode };
    }
    case "charge.dispute.created": return { id: ev.id, kind: "dispute", paymentId: idOf(o.payment_intent), orderId: null, livemode };
    default: return { id: ev.id, kind: "ignored", type: ev.type, livemode };
  }
}

export function sessionView(s: any): CheckoutSession {
  return {
    id: String(s.id), url: typeof s.url === "string" ? s.url : null,
    status: s.status === "complete" || s.status === "expired" ? s.status : "open",
    paymentStatus: s.payment_status === "paid" || s.payment_status === "no_payment_required" ? s.payment_status : "unpaid",
    amountTotal: num(s.amount_total), currency: typeof s.currency === "string" ? s.currency.toLowerCase() : null,
    paymentIntentId: idOf(s.payment_intent), livemode: !!s.livemode,
    orderId: typeof s.client_reference_id === "string" ? s.client_reference_id : typeof s.metadata?.order_id === "string" ? s.metadata.order_id : null,
  };
}

/** Verifies a Stripe-signed webhook body (default tolerance 300 s) and normalises it. */
export function verifyStripeWebhook(raw: string, signature: string | null, secret: string, stripe: StripeLike = offlineStripe()): NormalizedPaymentEvent {
  if (!signature) throw new WebhookSignatureError("missing signature");
  let ev;
  try {
    ev = stripe.webhooks.constructEvent(raw, signature, secret);
  } catch (e) {
    throw new WebhookSignatureError((e as Error).message);
  }
  return normalizeStripeEvent(ev);
}

export function createStripePayments(cfg: PaymentsConfig, stripe?: StripeLike): PaymentsPort {
  if (cfg.state !== "test" && cfg.state !== "live") throw new Error("moona: Stripe needs test or live payments");
  const client = stripe ?? (new Stripe(cfg.secretKey!, { maxNetworkRetries: 1, timeout: 10_000 }) as unknown as StripeLike);
  const call = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw new PaymentProviderError((e as Error).message);
    }
  };
  return {
    state: cfg.state,
    async createCheckout(o) {
      const s = await call(() => client.checkout.sessions.create({
        mode: "payment", line_items: [{ price: cfg.priceId, quantity: 1 }], payment_method_types: ["card"],
        client_reference_id: o.orderId, metadata: { order_id: o.orderId }, payment_intent_data: { metadata: { order_id: o.orderId } },
        success_url: o.successUrl, cancel_url: o.cancelUrl, expires_at: Math.floor(o.checkoutExpiresAt.getTime() / 1000),
      }, { idempotencyKey: `order:${o.orderId}` }));
      if (typeof s?.id !== "string" || typeof s?.url !== "string") throw new PaymentProviderError("checkout session without a url");
      return { sessionId: s.id, url: s.url };
    },
    retrieve: async (id) => sessionView(await call(() => client.checkout.sessions.retrieve(id))),
    async expire(id) {
      await call(() => client.checkout.sessions.expire(id));
    },
    verifyWebhook: (raw, sig) => verifyStripeWebhook(raw, sig, cfg.webhookSecret!, stripe ?? offlineStripe()),
  };
}
