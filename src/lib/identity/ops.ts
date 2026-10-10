// Operator devices (spec §3.2 ops): the team's own phones and laptops at the venue, signed in with
// OPS_TOKEN through /api/ops/session. An operator cookie lasts 12 hours. Operators may see budget
// details and payment problems, run test purchases on a deployment, and skip free quotas
// (AI_OPERATOR_QUOTA_EXEMPT, default on); never the money caps.
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import type { Keys } from "./keys";

export const OPS_COOKIE = "moona_ops";
export const OPS_TTL_S = 12 * 3600;

const sign = (keys: Keys, exp: number) => createHmac("sha256", keys.ops).update(`v1.${exp}`).digest("base64url");

export function opsCookieValue(keys: Keys, ttlS = OPS_TTL_S, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlS;
  return `v1.${exp}.${sign(keys, exp)}`;
}

export function verifyOpsCookie(value: string | undefined, keys: Keys, now = Date.now()): boolean {
  const m = value ? /^v1\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(value) : null;
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp * 1000 <= now) return false;
  const want = Buffer.from(sign(keys, exp));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function isOperator(req: NextRequest, keys: Keys | null): boolean {
  return !!keys && verifyOpsCookie(req.cookies.get(OPS_COOKIE)?.value, keys);
}

/** Whether a presented token is the configured OPS_TOKEN (at least 24 characters), in constant time. */
export function opsTokenMatches(token: unknown, env: Record<string, string | undefined> = process.env): boolean {
  const want = env.OPS_TOKEN ?? "";
  if (want.length < 24 || typeof token !== "string") return false;
  const a = createHmac("sha256", "moona-ops-compare").update(want).digest();
  const b = createHmac("sha256", "moona-ops-compare").update(token).digest();
  return timingSafeEqual(a, b);
}
