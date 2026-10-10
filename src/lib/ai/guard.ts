// Access gate + burst limits for AI routes. The persistent spend/call cap lives in budget.ts; these
// in-memory limits only smooth bursts. They are per visitor (a signed cookie, lib/visitor.ts), not
// per IP: on shared school Wi-Fi a whole room has one address (budget plan §5). A request without a
// valid visitor cookie (an API call that never loaded a page) falls into a per-IP bucket, and every
// IP has a high ceiling across all its visitors (sized for ~200 people behind one NAT) as an abuse backstop.
import "server-only";
import type { NextRequest } from "next/server";
import { aiConfig } from "./config";
import { sharedLedgerAvailable } from "./budget";
import { verifyVisitor, visitorSecret, VISITOR_COOKIE } from "@/lib/visitor";

export const AI_ACCESS_COOKIE = "moona-ai-access";
const WINDOW_MS = 60 * 60 * 1000;
export const AI_LIMITS = { perVisitor: 40, perAnonymousIp: 40, perIpCeiling: 2000 };
const hits = new Map<string, number[]>();

export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

export function hasAiAccess(req: NextRequest): boolean {
  const cfg = aiConfig();
  return !cfg.accessCode || req.cookies.get(AI_ACCESS_COOKIE)?.value === cfg.accessCode;
}

/** Why AI is not offered at all on this deployment (before any per-request check), or null. */
export function aiUnavailable(): "unconfigured" | "ledger" | "misconfigured" | null {
  const cfg = aiConfig();
  if (!cfg.apiKey || !cfg.model) return "unconfigured";
  if (!sharedLedgerAvailable()) return "ledger"; // no shared spend cap here: fail closed
  if (!visitorSecret()) return "misconfigured"; // deployed without SESSION_SECRET
  return null;
}

/** null when allowed; otherwise the reason. */
export function checkAiAccess(req: NextRequest): "unconfigured" | "ledger" | "misconfigured" | "locked" | "rate_limited" | null {
  const off = aiUnavailable();
  if (off) return off;
  if (!hasAiAccess(req)) return "locked";
  const ip = clientIp(req);
  const visitor = verifyVisitor(req.cookies.get(VISITOR_COOKIE)?.value, visitorSecret());
  const now = Date.now();
  const recent = (key: string) => (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  const ipKey = `ip:${ip}`;
  const ownKey = visitor ? `visitor:${visitor}` : `anon:${ip}`;
  const ipHits = recent(ipKey);
  const ownHits = recent(ownKey);
  if (ipHits.length >= AI_LIMITS.perIpCeiling || ownHits.length >= (visitor ? AI_LIMITS.perVisitor : AI_LIMITS.perAnonymousIp)) return "rate_limited";
  hits.set(ipKey, [...ipHits, now]);
  hits.set(ownKey, [...ownHits, now]);
  return null;
}

/** For tests. */
export function resetAiLimits() {
  hits.clear();
}
