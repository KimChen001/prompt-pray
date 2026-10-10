import { NextResponse, type NextRequest } from "next/server";
import { accountFor, packsContext } from "@/lib/payments/context";
import { syncOrder } from "@/lib/payments/service";
import { LedgerUnavailable } from "@/lib/ledger/port";

// The return page polls this: the owner's order, synced with the provider (a late webhook can't
// strand a payment), and the credits that are actually on the account.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const c = await packsContext(req);
  const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!c.ledger) return json({ code: "ledger" }, 503);
  try {
    const accountId = await accountFor(req, c);
    if (!accountId) return json({ code: "login_required" }, 401);
    const order = await syncOrder(c.ledger, c.pay, id, accountId);
    if (!order) return json({ code: "not_found" }, 404);
    const { credits } = await c.ledger.entitlements(accountId);
    return json({ order, credits }, 200);
  } catch (e) {
    if (e instanceof LedgerUnavailable) return json({ code: "ledger" }, 503);
    throw e;
  }
}
