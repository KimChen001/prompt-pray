import { NextResponse, type NextRequest } from "next/server";
import { hasAiAccess } from "@/lib/ai/guard";
import { ensureVisitor } from "@/lib/identity/visitor";
import { currentPlan, packsContext } from "@/lib/payments/context";
import { PaymentProviderError } from "@/lib/payments/port";
import { salesState, startCheckout } from "@/lib/payments/service";
import { LedgerUnavailable } from "@/lib/ledger/port";

export const maxDuration = 30;

const KEY = /^[A-Za-z0-9_-]{16,64}$/;

// Starts a pack purchase: the ledger holds the pack's AI allocation and the fee estimate first, then
// the provider's checkout is created and attached; only then is its url returned. Every cheap refusal
// (venue code, accounts, closed sales) comes before a visitor id is minted, so this route can't be used
// to use up the event's new-visitor allowance.
export async function POST(req: NextRequest) {
  const c = await packsContext(req);
  const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status });
  if (!c.pay || (c.cfg.state !== "fake" && c.cfg.state !== "test" && c.cfg.state !== "live")) return json({ code: "payments_off" }, 404);
  if (!c.ledger || !c.keys) return json({ code: "ledger" }, 503);
  if (!hasAiAccess(req) && !c.operator) return json({ code: "locked" }, 503);
  const body = (await req.json().catch(() => null)) as { productId?: unknown; checkoutKey?: unknown } | null;
  if (body?.productId !== "tarot5" || typeof body.checkoutKey !== "string" || !KEY.test(body.checkoutKey)) return json({ code: "bad_request" }, 400);
  if (!c.auth.ready({ isOperator: c.operator })) return json({ code: "login_required" }, 401);
  try {
    const plan = currentPlan();
    const sales = salesState(c.cfg, await c.ledger.snapshot(), { isOperator: c.operator, deployed: c.deployed, authReady: true, product: plan.product, packSlackMicro: Math.round(plan.plan.packSlackUsd * 1e6) });
    if (!sales.open) return json({ code: "sales_closed", reason: sales.reason }, 409);
    // the provider must charge the pack's price; checked before anything is minted or held
    if (c.pay.priceCheck) {
      const p = await c.pay.priceCheck();
      if (p.amountCents !== plan.product.amountCents || p.currency !== plan.product.currency.toLowerCase()) return json({ code: "sales_closed", reason: c.operator ? "price_mismatch" : "unconfigured" }, 409);
    }
    const visitor = await ensureVisitor(req, c.ledger, c.keys);
    if ("denied" in visitor) return json({ code: visitor.denied === "plan_unsynced" ? "unconfigured" : "visitor_cap" }, visitor.denied === "plan_unsynced" ? 503 : 429);
    const withCookie = (res: NextResponse) => {
      if (visitor.set) res.cookies.set({ name: visitor.set.name, value: visitor.set.value, ...visitor.set.options });
      return res;
    };
    const account = await c.auth.getAccount(req, { visitorId: visitor.id, ledger: c.ledger, isOperator: c.operator });
    if (!account) return withCookie(json({ code: "login_required" }, 401));
    const out = await startCheckout({ ledger: c.ledger, pay: c.pay, accountId: account.accountId, productId: "tarot5", checkoutKey: body.checkoutKey, siteUrl: c.cfg.siteUrl, expected: { amountCents: plan.product.amountCents, currency: plan.product.currency } });
    if ("denied" in out && out.denied === "price_mismatch") return withCookie(json({ code: "sales_closed", reason: c.operator ? "price_mismatch" : "unconfigured" }, 409));
    if ("denied" in out) {
      const code = out.denied === "sales_closed" || out.denied === "no_product" ? "sales_closed" : out.denied;
      return withCookie(json({ code, ...(code === "sales_closed" ? { reason: out.denied } : {}) }, out.denied === "plan_unsynced" ? 503 : 409));
    }
    return withCookie(json(out, 200));
  } catch (e) {
    if (e instanceof LedgerUnavailable) return json({ code: "ledger" }, 503);
    if (e instanceof PaymentProviderError) return json({ code: "provider_error" }, 502);
    throw e;
  }
}
