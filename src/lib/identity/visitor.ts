// A pseudonymous visitor id (spec §3.2), used only to share AI limits fairly: on shared school Wi-Fi
// many visitors have one IP, so limits can't be per IP. It is a random UUID in a signed cookie, minted
// the first time a browser actually reaches the ledger, and every mint counts against the event's
// mint caps (per window, and per network bucket), so clearing cookies can't mint free readings
// without limit. It is not linked to anything the person writes; the server stores only counters.
import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import type { LedgerPort } from "@/lib/ledger/port";
import type { Keys } from "./keys";

export const VISITOR_COOKIE = "moona_vid";
export const VISITOR_MAX_AGE = 15_552_000; // 180 days
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface CookieOpts { httpOnly: true; sameSite: "lax"; secure: boolean; path: "/"; maxAge: number }

const sign = (keys: Keys, uuid: string) => createHmac("sha256", keys.cookie).update(`v1.${uuid}`).digest("base64url");

export function visitorCookieValue(keys: Keys, uuid: string): string {
  return `v1.${uuid}.${sign(keys, uuid)}`;
}

/** The visitor id if the cookie is one this site signed; a forged or garbled cookie counts as absent. */
export function readVisitor(req: NextRequest, keys: Keys): string | null {
  return verifyVisitorCookie(req.cookies.get(VISITOR_COOKIE)?.value, keys);
}

export function verifyVisitorCookie(value: string | undefined, keys: Keys): string | null {
  const m = value ? /^v1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value) : null;
  if (!m || !UUID.test(m[1])) return null;
  const want = Buffer.from(sign(keys, m[1]));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : null;
}

export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip")?.trim() || "local";
}

/** The network a request came from (IPv4 /24, IPv6 /48) and the UTC day, keyed so the raw address is never stored. */
export function netBucket(req: NextRequest, keys: Keys, now = new Date()): string {
  const raw = clientIp(req);
  const ip = /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(raw) ? raw.slice(7) : raw; // IPv4-mapped IPv6
  let prefix = "other";
  if (isIP(ip) === 4) prefix = ip.split(".").slice(0, 3).join(".");
  else if (isIP(ip) === 6) {
    const [head, tail = ""] = ip.split("::");
    const groups = [...head.split(":").filter(Boolean), ...Array(8).fill("0"), ...tail.split(":").filter(Boolean)].slice(0, 3);
    prefix = groups.map((g) => g.toLowerCase()).join(":");
  }
  return createHmac("sha256", keys.net).update(`${now.toISOString().slice(0, 10)}|${prefix}`).digest("hex").slice(0, 32);
}

export type EnsuredVisitor =
  | { id: string; set?: { name: string; value: string; options: CookieOpts } }
  | { denied: "visitor_cap" | "plan_unsynced" };

/** The visitor behind a request, minting one (through the ledger's mint caps) when there is none. */
export async function ensureVisitor(req: NextRequest, ledger: LedgerPort, keys: Keys): Promise<EnsuredVisitor> {
  const id = readVisitor(req, keys);
  if (id) return { id };
  const minted = await ledger.mintVisitor(netBucket(req, keys));
  if (!minted.ok) return { denied: minted.reason === "plan_unsynced" ? "plan_unsynced" : "visitor_cap" };
  const fresh = randomUUID();
  return {
    id: fresh,
    set: { name: VISITOR_COOKIE, value: visitorCookieValue(keys, fresh), options: { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: VISITOR_MAX_AGE } },
  };
}
