// Payment modes (spec §11 payments.config, §7.3, §10.3): real charges need every precondition at
// once; anything less is "misconfigured" with each problem listed; the buy button never offers more
// than the mode allows.
import { describe, expect, it } from "vitest";
import { paymentsConfig } from "@/lib/payments/config";
import { purchaseAction, salesState } from "@/lib/payments/service";
import type { LedgerSnapshot } from "@/lib/ledger/port";
import type { ProductPlan } from "@/lib/ledger/plans";

const LIVE = {
  PAYMENTS_MODE: "live", STRIPE_SECRET_KEY: "sk_live_placeholder", STRIPE_WEBHOOK_SECRET: "whsec_placeholder", STRIPE_PRICE_ID: "price_placeholder",
  PAYMENTS_LIVE_CONFIRM: "I_ACCEPT_REAL_CHARGES", STORE_TERMS_URL: "https://example.test/terms", STORE_REFUND_POLICY_URL: "https://example.test/refunds",
  STORE_SUPPORT_CONTACT: "help@example.test", COMMERCIAL_ASSETS_CLEARED: "1", NEXT_PUBLIC_SITE_URL: "https://moona.example.test",
};
const product: ProductPlan = { id: "tarot5", amountCents: 500, currency: "usd", readings: 5, followupsPerReading: 2, attemptsPerUnit: 1, allocMicro: 2_000_000, feeHoldMicro: 520_000, maxSoldTest: 3, maxSoldLive: 10, checkoutTtlS: 1860 };
const pool = (id: string, cap: number, used = 0) => ({ id, kind: id, parentId: null, capMicro: cap, spentMicro: used, heldMicro: 0, overrunMicro: 0, callsCap: null, callsUsed: 0, startsAt: null, endsAt: null });
const snap = (o: { packs?: number; breaker?: "ok" | "tripped"; sales?: "open" | "closed"; sold?: number } = {}): LedgerSnapshot => ({
  kind: "sql", planId: "p", planHash: "h", activeWindowId: null, owedReadings: 0, reviewOrders: 0, sold: { test: o.sold ?? 0, live: o.sold ?? 0 },
  pools: [pool("ai", 50_000_000), pool("packs", o.packs ?? 5_000_000), pool("reserve", 30_000_000)],
  gate: { inflight: 0, breaker: o.breaker ?? "ok", breakerReason: null, sales: o.sales ?? "open", salesReason: null, cooldownUntil: null },
});

describe("payment modes", () => {
  it("is unconfigured by default, with checkout and webhook off", () => {
    expect(paymentsConfig({}, { ledgerKind: "postgres", authKind: "none" })).toMatchObject({ state: "unconfigured", webhookEnabled: false, problems: [] });
  });

  it("refuses a live key in test mode, and lists the problem", () => {
    const c = paymentsConfig({ PAYMENTS_MODE: "test", STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_ID: "price_x" }, { ledgerKind: "postgres", authKind: "fake" });
    expect(c.state).toBe("misconfigured");
    expect(c.problems).toEqual(["STRIPE_SECRET_KEY is a live key but PAYMENTS_MODE is test"]);
    expect(c.secretKey).toBeUndefined();
  });

  it("goes live only with every precondition, naming each missing one", () => {
    expect(paymentsConfig(LIVE, { ledgerKind: "postgres", authKind: "email" }).state).toBe("live");
    const missing = paymentsConfig({ PAYMENTS_MODE: "live", STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_ID: "price_x", NEXT_PUBLIC_SITE_URL: "http://moona.test" }, { ledgerKind: "pglite", authKind: "fake" });
    expect(missing.state).toBe("misconfigured");
    expect(missing.problems).toHaveLength(8);
    expect(missing.problems.join(" ")).toMatch(/PAYMENTS_LIVE_CONFIRM.*real account provider.*Postgres.*STORE_TERMS_URL.*STORE_REFUND_POLICY_URL.*STORE_SUPPORT_CONTACT.*COMMERCIAL_ASSETS_CLEARED.*https/);
  });

  it("allows fake payments only off deployments (or a rehearsal preview), on the SQL ledger", () => {
    expect(paymentsConfig({ PAYMENTS_MODE: "fake" }, { ledgerKind: "memory", authKind: "fake" })).toMatchObject({ state: "fake", webhookEnabled: true });
    expect(paymentsConfig({ PAYMENTS_MODE: "fake" }, { ledgerKind: "file", authKind: "fake" }).state).toBe("misconfigured");
    expect(paymentsConfig({ PAYMENTS_MODE: "fake", VERCEL: "1" }, { ledgerKind: "postgres", authKind: "fake" }).state).toBe("misconfigured");
    expect(paymentsConfig({ PAYMENTS_MODE: "fake", VERCEL: "1", PAYMENTS_ALLOW_FAKE_ON_DEPLOY: "1", FAKE_WEBHOOK_SECRET: "whsec_preview" }, { ledgerKind: "postgres", authKind: "fake" }).state).toBe("fake");
  });

  it("keeps the webhook on while sales are closed", () => {
    const c = paymentsConfig(LIVE, { ledgerKind: "postgres", authKind: "email" });
    expect(c.webhookEnabled).toBe(true);
    expect(salesState(c, snap({ sales: "closed" }), { isOperator: false, deployed: true, authReady: true, product, packSlackMicro: 1_000_000 })).toEqual({ open: false, reason: "closed" });
  });
});

describe("sales state", () => {
  const live = paymentsConfig(LIVE, { ledgerKind: "postgres", authKind: "email" });
  const test = paymentsConfig({ PAYMENTS_MODE: "test", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_ID: "price_x" }, { ledgerKind: "postgres", authKind: "fake" });
  const ctx = { isOperator: false, deployed: true, authReady: true, product, packSlackMicro: 1_000_000 };
  it("gives the first failing reason in the documented order", () => {
    expect(salesState(paymentsConfig({}, { ledgerKind: null, authKind: "none" }), snap(), ctx).reason).toBe("unconfigured");
    expect(salesState(test, snap(), ctx).reason).toBe("operators_only");
    expect(salesState(live, snap(), { ...ctx, authReady: false }).reason).toBe("login_unavailable");
    expect(salesState(live, null, ctx).reason).toBe("ledger");
    expect(salesState(live, snap({ breaker: "tripped", sales: "closed" }), ctx).reason).toBe("paused");
    expect(salesState(live, snap({ sales: "closed" }), ctx).reason).toBe("closed");
    expect(salesState(live, snap({ packs: 0 }), ctx).reason).toBe("no_pack_pool");
    expect(salesState(live, snap({ sold: 10 }), ctx).reason).toBe("sold_out");
    expect(salesState(live, snap({ packs: 2_500_000 }), ctx).reason).toBe("budget_short");
    expect(salesState(live, snap(), ctx)).toEqual({ open: true, reason: null });
    expect(salesState(test, snap(), { ...ctx, isOperator: true })).toEqual({ open: true, reason: null });
  });

  it("offers a real purchase only live and open, tests only to operators on a deployment", () => {
    expect(purchaseAction("live", true, { isOperator: false, deployed: true })).toEqual({ kind: "buy" });
    expect(purchaseAction("live", false, { isOperator: true, deployed: true })).toBeNull();
    expect(purchaseAction("test", true, { isOperator: false, deployed: true })).toBeNull();
    expect(purchaseAction("test", true, { isOperator: true, deployed: true })).toEqual({ kind: "test" });
    expect(purchaseAction("test", true, { isOperator: false, deployed: false })).toEqual({ kind: "test" });
    expect(purchaseAction("fake", true, { isOperator: false, deployed: false })).toEqual({ kind: "simulate" });
    expect(purchaseAction("unconfigured", true, { isOperator: true, deployed: false })).toBeNull();
    expect(purchaseAction("misconfigured", true, { isOperator: true, deployed: false })).toBeNull();
  });
});
