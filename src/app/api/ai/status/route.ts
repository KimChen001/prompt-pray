import { NextResponse, type NextRequest } from "next/server";
import { aiConfig } from "@/lib/ai/config";
import { budgetFor } from "@/lib/ai/provider";
import { hasAiAccess } from "@/lib/ai/guard";

// Whether AI is usable from this browser, and — only for clients with access — which provider/model
// and how much of the budget is used. Never returns keys.
export async function GET(req: NextRequest) {
  const cfg = aiConfig();
  const configured = !!cfg.apiKey && !!cfg.model;
  const access = hasAiAccess(req);
  if (!configured || !access) {
    return NextResponse.json({ available: false, reason: configured ? "locked" : "unconfigured" }, { headers: { "Cache-Control": "no-store" } });
  }
  let budget;
  try { budget = await budgetFor(cfg).snapshot(); }
  catch {
    return NextResponse.json({ available: false, reason: "budget" }, { headers: { "Cache-Control": "no-store" } });
  }
  const exhausted = budget.usdTotal + budget.reservedUsdTotal >= budget.limits.maxUsdTotal || budget.usdToday + budget.reservedUsdToday >= budget.limits.maxUsdPerDay || budget.callsToday >= budget.limits.maxCallsPerDay;
  return NextResponse.json(
    { available: !exhausted, reason: exhausted ? "budget" : null, provider: cfg.provider, model: cfg.model, budget },
    { headers: { "Cache-Control": "no-store" } },
  );
}
