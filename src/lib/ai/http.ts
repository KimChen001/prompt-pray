import "server-only";
import { NextResponse } from "next/server";
import type { AiError } from "./types";
import type { MeterOutcome } from "./meter";
import type { DenyReason } from "@/lib/ledger/port";

/** Maps AI failures to HTTP; clients keep their offline text for every one of these. */
export function aiErrorResponse(e: AiError) {
  const status =
    e.code === "unconfigured" || e.code === "budget" || e.code === "ledger" ? 503 :
    e.code === "timeout" ? 504 :
    502; // upstream, bad_output, refused
  return NextResponse.json({ code: e.code }, { status });
}

const BUDGET: ReadonlySet<DenyReason> = new Set(["no_window", "total_usd", "window_usd", "window_calls", "slice_usd", "purpose_closed"]);
const jitter = (ms: number) => Math.round(ms * (0.7 + Math.random() * 0.6));

/** The HTTP answer for a metered request (spec §8.2). `body` is the route's response for a value. */
export function meterResponse(o: MeterOutcome<unknown>, body: Record<string, unknown> = {}, extra: { credits?: number | null; budgetLevel?: string | null } = {}): NextResponse {
  const json = (b: Record<string, unknown>, status: number) => NextResponse.json(b, { status });
  switch (o.kind) {
    case "fresh":
    case "replayed":
      return json({
        ...body,
        ...(o.kind === "replayed" ? { replayed: true } : {}),
        ...(o.paidReadingId ? { paidReadingId: o.paidReadingId } : {}),
        ...(o.followupsLeft !== undefined ? { followupsLeft: o.followupsLeft } : {}),
        ...(extra.budgetLevel ? { budgetLevel: extra.budgetLevel } : {}),
      }, 200);
    case "in_progress":
      return json({ code: "in_progress", retryAfterMs: o.retryAfterMs }, 202);
    case "retry_new_key":
      return json({ code: "retry_new_key" }, 409);
    case "unavailable":
      return json({ code: "ledger" }, 503);
    case "failed":
      return aiErrorResponse(o.error);
    case "denied": {
      const r = o.reason;
      if (r === "key_reused") return json({ code: r }, 422);
      if (r === "subject_quota") return json({ code: "quota", credits: extra.credits ?? null }, 429);
      if (r === "subject_failures") return json({ code: r }, 429);
      if (r === "subject_busy") return json({ code: r, retryAfterMs: 3000 }, 429);
      if (r === "busy") return json({ code: r, retryAfterMs: Math.min(5000, Math.max(2000, jitter(3000))) }, 503);
      if (r === "cooldown") return json({ code: r, retryAfterMs: Math.max(1000, (o.retryAfterS ?? 2) * 1000) }, 503);
      if (r === "paused" || r === "paid_capacity") return json({ code: r }, 503);
      if (r === "plan_unsynced") return json({ code: "unconfigured" }, 503);
      if (BUDGET.has(r)) return json({ code: "budget" }, 503);
      if (r === "no_credits") return json({ code: r }, 402); // the sales state joins with packs (S4)
      return json({ code: r }, 409); // no_such_reading, reading_mismatch, no_followups, lot_closed
    }
  }
}
