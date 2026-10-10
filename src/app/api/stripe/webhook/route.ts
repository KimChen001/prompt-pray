import { NextResponse, type NextRequest } from "next/server";
import { packsContext } from "@/lib/payments/context";
import { handleWebhook } from "@/lib/payments/service";
import { LedgerUnavailable } from "@/lib/ledger/port";

export const maxDuration = 15;

// Payment events from the provider. The signature is checked on the raw body, before anything is
// written; a replayed event is a no-op; a ledger outage answers 503 so the provider delivers again.
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const c = await packsContext(req);
  const out = await handleWebhook(raw, req.headers.get("stripe-signature"), {
    ledger: async () => {
      if (!c.ledger) throw new LedgerUnavailable("ledger_down");
      return c.ledger;
    },
    pay: c.pay,
    cfg: c.cfg,
  });
  return NextResponse.json(out.body, { status: out.status });
}
