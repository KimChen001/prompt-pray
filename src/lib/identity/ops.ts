// Operator devices (spec §3.2 ops): the team's own phones and laptops at the venue, signed in with
// OPS_TOKEN through /api/ops/session. An operator cookie lasts 12 hours and is bound to the current
// OPS_TOKEN, so rotating the token signs every device out. Without an OPS_TOKEN there are no operators.
// Operators may see budget details and payment problems, run test purchases on a deployment, and skip
// free quotas (AI_OPERATOR_QUOTA_EXEMPT, default on); never the money caps.
import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import type { EnvLike } from "@/lib/host";
import type { Keys } from "./keys";

export const OPS_COOKIE = "moona_ops";
export const OPS_TTL_S = 12 * 3600;

const token = (env: EnvLike) => {
  const t = env.OPS_TOKEN ?? "";
  return t.length >= 24 ? t : null;
};
const sign = (keys: Keys, exp: number, opsToken: string) =>
  createHmac("sha256", keys.ops).update(`v1.${exp}.${createHash("sha256").update(opsToken).digest("hex")}`).digest("base64url");

export function opsCookieValue(keys: Keys, ttlS = OPS_TTL_S, now = Date.now(), env: EnvLike = process.env): string {
  const t = token(env);
  if (!t) throw new Error("moona: no OPS_TOKEN, so no operator devices");
  const exp = Math.floor(now / 1000) + ttlS;
  return `v1.${exp}.${sign(keys, exp, t)}`;
}

export function verifyOpsCookie(value: string | undefined, keys: Keys, now = Date.now(), env: EnvLike = process.env): boolean {
  const t = token(env);
  const m = value ? /^v1\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(value) : null;
  if (!t || !m) return false;
  const exp = Number(m[1]);
  if (exp * 1000 <= now) return false;
  const want = Buffer.from(sign(keys, exp, t));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function isOperator(req: NextRequest, keys: Keys | null, env: EnvLike = process.env): boolean {
  return !!keys && verifyOpsCookie(req.cookies.get(OPS_COOKIE)?.value, keys, Date.now(), env);
}

/** Whether a presented token is the configured OPS_TOKEN (at least 24 characters), in constant time. */
export function opsTokenMatches(presented: unknown, env: EnvLike = process.env): boolean {
  const want = token(env);
  if (!want || typeof presented !== "string") return false;
  const a = createHmac("sha256", "moona-ops-compare").update(want).digest();
  const b = createHmac("sha256", "moona-ops-compare").update(presented).digest();
  return timingSafeEqual(a, b);
}
