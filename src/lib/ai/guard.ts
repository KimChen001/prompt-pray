// Access gate + per-client burst limit for AI routes. The persistent spend/call cap lives in
// budget.ts; this in-memory limiter only smooths bursts from one client.
import "server-only";
import type { NextRequest } from "next/server";
import { aiConfig } from "./config";

export const AI_ACCESS_COOKIE = "moona-ai-access";
const WINDOW_MS = 60 * 60 * 1000;
const LIMIT_PER_WINDOW = 40;
const hits = new Map<string, number[]>();

export function clientKey(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

export function hasAiAccess(req: NextRequest): boolean {
  const cfg = aiConfig();
  return !cfg.accessCode || req.cookies.get(AI_ACCESS_COOKIE)?.value === cfg.accessCode;
}

/** null when allowed; otherwise the reason. */
export function checkAiAccess(req: NextRequest): "unconfigured" | "locked" | "rate_limited" | null {
  const cfg = aiConfig();
  if (!cfg.apiKey || !cfg.model) return "unconfigured";
  if (!hasAiAccess(req)) return "locked";
  const key = clientKey(req);
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT_PER_WINDOW) return "rate_limited";
  recent.push(now);
  hits.set(key, recent);
  return null;
}

/** For tests. */
export function resetAiLimits() {
  hits.clear();
}
