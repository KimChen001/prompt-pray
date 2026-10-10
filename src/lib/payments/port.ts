// The payment provider contract (spec §3.4). Stripe and the offline fake both turn their events into
// NormalizedPaymentEvent before anything touches the ledger; checkout metadata carries only the
// opaque order id, never a question, reading or birth detail.

export interface CheckoutSession {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  amountTotal: number | null;
  currency: string | null;
  paymentIntentId: string | null;
  livemode: boolean;
  orderId: string | null;
}

export type NormalizedPaymentEvent =
  | { id: string; kind: "paid" | "unpaid"; orderId: string | null; sessionId: string; paymentId: string | null; amountCents: number | null; currency: string | null; livemode: boolean }
  | { id: string; kind: "expired" | "async_failed"; sessionId: string; livemode: boolean }
  | { id: string; kind: "refund_full" | "refund_partial" | "dispute"; paymentId: string | null; orderId: string | null; livemode: boolean }
  | { id: string; kind: "ignored"; type: string; livemode: boolean };

export interface PaymentsPort {
  readonly state: "fake" | "test" | "live";
  /** amountCents/currency are what the order says; Stripe charges its own price id and reports the amount back. */
  createCheckout(o: { orderId: string; checkoutExpiresAt: Date; successUrl: string; cancelUrl: string; amountCents?: number; currency?: string }): Promise<{ sessionId: string; url: string }>;
  retrieve(sessionId: string): Promise<CheckoutSession>;
  expire(sessionId: string): Promise<void>;
  /** Throws WebhookSignatureError for a bad, stale or re-serialised payload. */
  verifyWebhook(raw: string, signature: string | null): NormalizedPaymentEvent;
}

export class WebhookSignatureError extends Error {}
export class PaymentProviderError extends Error {}
