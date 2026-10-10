// A pseudonymous visitor id, signed so it can't be forged, used only to share AI limits fairly between
// people (budget plan §5: on shared school Wi-Fi many visitors have one IP, so limits can't be per IP).
// It is a random value set by src/proxy.ts on page loads; it is not linked to anything the person
// writes, nothing about it is stored on the server, and clearing cookies simply gives a new one.
import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isDeployed } from "@/lib/host";

export const VISITOR_COOKIE = "moona-v";
export const VISITOR_MAX_AGE = 60 * 60 * 24 * 90;

let devSecret: string | null = null;

/**
 * The key that signs visitor ids: SESSION_SECRET (at least 32 characters, generated and set by the
 * team in the host's environment, never pasted into chat). Locally a random per-process key is used.
 * On a deployment without SESSION_SECRET there is none, and AI stays off (guard.ts "misconfigured").
 */
export function visitorSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (isDeployed(env)) return null;
  return (devSecret ??= randomBytes(32).toString("base64url"));
}

const sign = (id: string, secret: string) => createHmac("sha256", secret).update(`moona-visitor:${id}`).digest("base64url").slice(0, 22);

export function mintVisitor(secret: string): string {
  const id = randomBytes(16).toString("base64url");
  return `${id}.${sign(id, secret)}`;
}

/** The visitor id if the cookie value is one this site signed, else null. */
export function verifyVisitor(value: string | undefined, secret: string | null): string | null {
  if (!value || !secret) return null;
  const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(value);
  if (!m) return null;
  const want = Buffer.from(sign(m[1], secret));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : null;
}
