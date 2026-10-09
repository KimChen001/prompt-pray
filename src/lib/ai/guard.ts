// Access gate + per-client rate limit for AI routes (plan v0.2 §4.2).
// In-memory limits reset when a serverless instance restarts; good enough for a demo, and
// Supabase-backed limits replace this once the community backend exists.
import "server-only";
import type { NextRequest } from "next/server";
import { aiConfig } from "./provider";

export const AI_ACCESS_COOKIE = "moona-ai-access";
const WINDOW_MS = 60 * 60 * 1000;
const LIMIT_PER_WINDOW = 40;
const hits = new Map<string, number[]>();

export function clientKey(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

/** null when allowed; otherwise the reason. */
export function checkAiAccess(req: NextRequest): "unconfigured" | "locked" | "rate_limited" | null {
  const cfg = aiConfig();
  if (!cfg.apiKey) return "unconfigured";
  if (cfg.accessCode && req.cookies.get(AI_ACCESS_COOKIE)?.value !== cfg.accessCode) return "locked";
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
