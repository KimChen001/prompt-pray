import { NextResponse, type NextRequest } from "next/server";
import { packsContext } from "@/lib/payments/context";
import type { FakePayments, FakeOutcome } from "@/lib/payments/fake";
import { PaymentProviderError } from "@/lib/payments/port";

// The simulated checkout page's buttons (fake mode only; off deployments, or operators on a
// rehearsal preview). It sends the provider-shaped, signed events through the real webhook path.
const OUTCOMES: readonly FakeOutcome[] = ["pay", "unpaid", "decline", "expire", "refund", "partial_refund", "dispute"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function POST(req: NextRequest) {
  const c = await packsContext(req);
  if (c.cfg.state !== "fake" || !c.pay || (c.deployed && !c.operator)) return NextResponse.json({ code: "not_found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { orderId?: unknown; outcome?: unknown; duplicate?: unknown } | null;
  const orderId = typeof body?.orderId === "string" && UUID.test(body.orderId) ? body.orderId : null;
  const outcome = OUTCOMES.find((o) => o === body?.outcome);
  if (!orderId || !outcome) return NextResponse.json({ code: "bad_request" }, { status: 400 });
  try {
    const outcomes = await (c.pay as FakePayments).deliver(orderId, outcome, { duplicate: body?.duplicate === true });
    return NextResponse.json({ outcomes });
  } catch (e) {
    if (e instanceof PaymentProviderError) return NextResponse.json({ code: "no_checkout" }, { status: 404 });
    throw e;
  }
}
