import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { aiConfig } from "@/lib/ai/config";
import { budgetLevel } from "@/lib/ledger/levels";
import { typicalCallMicro } from "@/lib/ledger/plans";
import { LedgerUnavailable } from "@/lib/ledger/port";
import { currentPlan, packsContext } from "@/lib/payments/context";
import { reconcile } from "@/lib/payments/service";

export const maxDuration = 60;

// Housekeeping: reap expired leases, settle orders the provider has finished, purge old texts, and
// audit every counter (any violation pauses spending). GET is for the scheduler (Bearer CRON_SECRET);
// POST is for an operator device.
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

async function run(req: NextRequest) {
  const c = await packsContext(req);
  if (!c.ledger) return NextResponse.json({ code: "ledger" }, { status: 503 });
  try {
    const r = await reconcile(c.ledger, c.pay);
    const level = budgetLevel(await c.ledger.snapshot(), currentPlan().plan.warnAt, typicalCallMicro(aiConfig())).level;
    return NextResponse.json({ reaped: r.reaped, ordersSynced: r.ordersSynced, purged: r.purged, auditViolations: r.audit.length, level }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof LedgerUnavailable) return NextResponse.json({ code: "ledger" }, { status: 503 });
    throw e;
  }
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) return NextResponse.json({ code: "not_found" }, { status: 404 });
  if (!same(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return NextResponse.json({ code: "unauthorized" }, { status: 401 });
  return run(req);
}

export async function POST(req: NextRequest) {
  const c = await packsContext(req);
  if (!c.operator) return NextResponse.json({ code: "unauthorized" }, { status: 401 });
  return run(req);
}
