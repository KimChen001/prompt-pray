// DEV/REHEARSAL ONLY. Payments with no provider and no money (PAYMENTS_MODE=fake; refused on a
// deployment unless a rehearsal preview opts in). Checkout is a local page; deliver() builds
// Stripe-shaped events, signs them like Stripe does and hands them to the real webhook handler, so the
// whole verify → normalise → ledger path runs exactly as it would with Stripe test mode.
import "server-only";
import { randomBytes } from "node:crypto";
import type { PaymentsConfig } from "./config";
import { PaymentProviderError, type CheckoutSession, type NormalizedPaymentEvent, type PaymentsPort } from "./port";
import { offlineStripe, verifyStripeWebhook } from "./stripe";

export type FakeOutcome = "pay" | "unpaid" | "decline" | "expire" | "refund" | "partial_refund" | "dispute";

interface FakeSession { id: string; orderId: string; status: CheckoutSession["status"]; paymentStatus: CheckoutSession["paymentStatus"]; amount: number; currency: string; paymentIntent: string }
const sessions = ((globalThis as { __moonaFakeSessions?: Map<string, FakeSession> }).__moonaFakeSessions ??= new Map());

export type WebhookSink = (raw: string, signature: string) => Promise<{ status: number; body: Record<string, unknown> }>;

export interface FakePayments extends PaymentsPort {
  /** Sends the events a real provider would for this outcome; returns each delivery's outcome. */
  deliver(orderId: string, outcome: FakeOutcome, o?: { duplicate?: boolean }): Promise<string[]>;
}

export function createFakePayments(cfg: PaymentsConfig, sink?: WebhookSink): FakePayments {
  if (cfg.state !== "fake" || !cfg.webhookSecret) throw new Error("moona: fake payments need PAYMENTS_MODE=fake");
  const secret = cfg.webhookSecret;
  const view = (s: FakeSession): CheckoutSession => ({ id: s.id, url: `/packs/fake-checkout/${s.orderId}`, status: s.status, paymentStatus: s.paymentStatus, amountTotal: s.amount, currency: s.currency, paymentIntentId: s.paymentIntent, livemode: false, orderId: s.orderId });
  const event = (type: string, object: Record<string, unknown>) => JSON.stringify({ id: `evt_fake_${randomBytes(9).toString("base64url")}`, object: "event", type, livemode: false, created: Math.floor(Date.now() / 1000), data: { object } });
  const sessionObject = (s: FakeSession) => ({ id: s.id, object: "checkout.session", client_reference_id: s.orderId, metadata: { order_id: s.orderId }, payment_status: s.paymentStatus, status: s.status, amount_total: s.amount, currency: s.currency, payment_intent: s.paymentIntent, livemode: false });

  return {
    state: "fake",
    async createCheckout(o) {
      const id = `cs_fake_${o.orderId}`;
      if (!sessions.has(id)) sessions.set(id, { id, orderId: o.orderId, status: "open", paymentStatus: "unpaid", amount: o.amountCents ?? 0, currency: (o.currency ?? "usd").toLowerCase(), paymentIntent: `pi_fake_${o.orderId}` });
      return { sessionId: id, url: `/packs/fake-checkout/${o.orderId}` };
    },
    async retrieve(id) {
      const s = sessions.get(id);
      if (!s) throw new PaymentProviderError("no such fake session");
      return view(s);
    },
    async expire(id) {
      const s = sessions.get(id);
      if (s && s.status === "open") s.status = "expired";
    },
    verifyWebhook: (raw, sig): NormalizedPaymentEvent => verifyStripeWebhook(raw, sig, secret),
    async deliver(orderId, outcome, o = {}) {
      if (!sink) throw new Error("moona: fake payments were created without a webhook handler");
      const s = sessions.get(`cs_fake_${orderId}`);
      if (!s) throw new PaymentProviderError("no checkout for this order");
      let payload: string;
      switch (outcome) {
        case "pay": {
          // a session already completed unpaid (a delayed payment method) is paid by the async event
          const delayed = s.status === "complete" && s.paymentStatus === "unpaid";
          s.status = "complete";
          s.paymentStatus = "paid";
          payload = event(delayed ? "checkout.session.async_payment_succeeded" : "checkout.session.completed", sessionObject(s));
          break;
        }
        case "unpaid":
          s.status = "complete";
          s.paymentStatus = "unpaid";
          payload = event("checkout.session.completed", sessionObject(s));
          break;
        case "decline":
          payload = event("checkout.session.async_payment_failed", sessionObject(s));
          break;
        case "expire":
          s.status = "expired";
          payload = event("checkout.session.expired", sessionObject(s));
          break;
        case "refund":
        case "partial_refund":
          payload = event("charge.refunded", { id: `ch_fake_${orderId}`, object: "charge", payment_intent: s.paymentIntent, amount: s.amount, amount_refunded: outcome === "refund" ? s.amount : Math.floor(s.amount / 2), metadata: { order_id: orderId } });
          break;
        case "dispute":
          payload = event("charge.dispute.created", { id: `dp_fake_${orderId}`, object: "dispute", payment_intent: s.paymentIntent, amount: s.amount });
          break;
      }
      const sign = () => offlineStripe().webhooks.generateTestHeaderString({ payload, secret });
      const outcomes: string[] = [];
      for (let i = 0; i < (o.duplicate ? 2 : 1); i++) {
        const r = await sink(payload, sign());
        outcomes.push(String(r.body.outcome ?? r.body.code ?? r.status));
      }
      return outcomes;
    },
  };
}

/** For tests: forget every fake checkout session. */
export function resetFakePayments(): void {
  sessions.clear();
}
