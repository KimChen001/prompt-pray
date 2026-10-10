import { NextResponse, type NextRequest } from "next/server";
import { aiConfig } from "@/lib/ai/config";
import { aiUnavailable, hasAiAccess } from "@/lib/ai/guard";
import { serverKeys } from "@/lib/identity/keys";
import { isOperator } from "@/lib/identity/ops";
import { budgetLevel } from "@/lib/ledger/levels";
import { getLedger, planWarning } from "@/lib/ledger/factory";
import { typicalCallMicro } from "@/lib/ledger/plans";

const NO_STORE = { "Cache-Control": "no-store" };

function warnAt(): [number, number, number] {
  const w = (process.env.AI_WARN_AT ?? "").split(",").map(Number);
  return w.length === 3 && w.every(Number.isFinite) ? (w as [number, number, number]) : [0.5, 0.8, 0.95];
}

// Whether AI is usable from this browser and how close tonight's budget is to its limits. Clients with
// access (the venue code, shared with every attendee) see only that, plus the provider and model.
// Spending, holds, sales and order states, and plan problems go to operator devices only.
// Never returns keys.
export async function GET(req: NextRequest) {
  const cfg = aiConfig();
  const off = aiUnavailable();
  const operator = isOperator(req, serverKeys());
  if (off || (!hasAiAccess(req) && !operator)) return NextResponse.json({ available: false, reason: off ?? "locked" }, { headers: NO_STORE });
  const got = await getLedger();
  if (!got.ok) return NextResponse.json({ available: false, reason: "ledger" }, { headers: NO_STORE });
  let snapshot;
  try {
    snapshot = await got.ledger.snapshot();
  } catch {
    // an unreadable file ledger, or a database that is down
    return NextResponse.json({ available: false, reason: got.ledger.kind === "file" ? "budget" : "ledger" }, { headers: NO_STORE });
  }
  const { level, ratio } = budgetLevel(snapshot, warnAt(), typicalCallMicro(cfg));
  const budget = snapshot.kind === "file" ? snapshot.legacy : { ...snapshot, ratio, planMismatch: planWarning() };
  const paused = snapshot.kind === "sql" && (snapshot.gate.breaker === "tripped" || !snapshot.planId);
  const available = level !== "exhausted" && !paused;
  return NextResponse.json(
    { available, reason: available ? null : "budget", level, provider: cfg.provider, model: cfg.model, ...(operator ? { budget } : {}) },
    { headers: NO_STORE },
  );
}
