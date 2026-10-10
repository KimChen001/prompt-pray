// Access gate for AI routes. Spending caps, per-visitor quotas and replay live in the ledger
// (lib/ledger); identity is a signed pseudonymous visitor cookie (lib/identity/visitor.ts), never the
// IP: on shared school Wi-Fi a whole room has one address (budget plan §5). The only in-memory limit
// left is a burst limit for the legacy file ledger, which has no per-visitor quotas of its own.
import "server-only";
import type { NextRequest } from "next/server";
import { aiConfig, aiConfigured } from "./config";
import { serverKeys } from "@/lib/identity/keys";
import { ledgerConfigured } from "@/lib/ledger/factory";
import type { EnvLike } from "@/lib/host";

export const AI_ACCESS_COOKIE = "moona-ai-access";
const WINDOW_MS = 60 * 60 * 1000;
export const AI_LIMITS = { perVisitor: 40 };
const hits = new Map<string, number[]>();

export function hasAiAccess(req: NextRequest, env: EnvLike = process.env): boolean {
  const cfg = aiConfig(env);
  return !cfg.accessCode || req.cookies.get(AI_ACCESS_COOKIE)?.value === cfg.accessCode;
}

/** Why AI is not offered at all on this deployment (before any per-request check), or null. */
export function aiUnavailable(env: EnvLike = process.env): "unconfigured" | "ledger" | "misconfigured" | null {
  const cfg = aiConfig(env);
  if (!aiConfigured(cfg, env)) return "unconfigured";
  if (!ledgerConfigured(env)) return "ledger"; // no shared spend cap here: fail closed
  if (!serverKeys(env)) return "misconfigured"; // deployed without SESSION_SECRET
  return null;
}

/** null when allowed; otherwise why not. */
export function checkAiAccess(req: NextRequest, env: EnvLike = process.env): "unconfigured" | "ledger" | "misconfigured" | "locked" | null {
  return aiUnavailable(env) ?? (hasAiAccess(req, env) ? null : "locked");
}

/** True when this visitor is over the hourly burst limit (file ledger only). Counts the call when not. */
export function burstLimit(subjectKey: string, now = Date.now()): boolean {
  const recent = (hits.get(subjectKey) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= AI_LIMITS.perVisitor) {
    hits.set(subjectKey, recent);
    return true;
  }
  hits.set(subjectKey, [...recent, now]);
  return false;
}

/** For tests. */
export function resetAiLimits() {
  hits.clear();
}
