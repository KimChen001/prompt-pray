import { NextResponse, type NextRequest } from "next/server";
import { aiConfig } from "@/lib/ai/config";
import { accountFor, currentPlan, packsContext } from "@/lib/payments/context";
import { purchaseAction, salesState } from "@/lib/payments/service";

const NO_STORE = { "Cache-Control": "no-store" };

// What the packs panel shows: the payment mode, whether sales are open (and the first reason when
// not), the product's terms, and this browser's account and credits. Problems with the payment setup
// are shown only to operator devices; the public sees "not enabled".
export async function GET(req: NextRequest) {
  const c = await packsContext(req);
  const plan = currentPlan();
  let snap = null;
  try {
    snap = c.ledger ? await c.ledger.snapshot() : null;
  } catch {
    snap = null;
  }
  const sales = salesState(c.cfg, snap, { isOperator: c.operator, deployed: c.deployed, authReady: c.auth.ready({ isOperator: c.operator }), product: plan.product, packSlackMicro: Math.round(plan.plan.packSlackUsd * 1e6) });
  let accountId: string | null = null, entitlements;
  try {
    accountId = await accountFor(req, c);
    if (accountId && c.ledger) entitlements = await c.ledger.entitlements(accountId);
  } catch {
    accountId = null;
  }
  const publicState = c.cfg.state === "misconfigured" && !c.operator ? "unconfigured" : c.cfg.state;
  return NextResponse.json({
    payments: { state: publicState, ...(c.operator && c.cfg.problems.length ? { problems: c.cfg.problems } : {}) },
    sales,
    // what the buy button may do here (never more than the mode allows)
    action: purchaseAction(c.cfg.state, sales.open, { isOperator: c.operator, deployed: c.deployed }),
    product: {
      priceCents: plan.product.amountCents, currency: plan.product.currency, readings: plan.product.readings, followupsPerReading: plan.product.followupsPerReading,
      excludes: ["talk", "natal"], model: aiConfig().model, termsUrl: c.cfg.termsUrl ?? null, refundUrl: c.cfg.refundUrl ?? null, support: c.cfg.supportContact ?? null,
    },
    account: { signedIn: !!accountId, provider: c.auth.kind },
    ...(entitlements ? { entitlements } : {}),
  }, { headers: NO_STORE });
}
