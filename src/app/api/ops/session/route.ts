import { NextResponse, type NextRequest } from "next/server";
import { serverKeys } from "@/lib/identity/keys";
import { OPS_COOKIE, OPS_TTL_S, opsCookieValue, opsTokenMatches } from "@/lib/identity/ops";
import { netBucket } from "@/lib/identity/visitor";

// Marks this device as an operator's for 12 hours, given OPS_TOKEN (set by the team in the host's
// environment; at least 24 characters). Failed attempts are throttled per network and server
// instance, so guessing from one network can't lock the team out everywhere.
const WINDOW_MS = 10 * 60 * 1000, MAX_FAILS = 10;
const fails = new Map<string, number[]>();

export async function POST(req: NextRequest) {
  const keys = serverKeys();
  if (!keys || (process.env.OPS_TOKEN ?? "").length < 24) return NextResponse.json({ code: "not_found" }, { status: 404 });
  const now = Date.now();
  const bucket = netBucket(req, keys);
  const recent = (fails.get(bucket) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_FAILS) return NextResponse.json({ code: "rate_limited" }, { status: 429 });
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  if (!opsTokenMatches(body?.token)) {
    fails.set(bucket, [...recent, now]);
    return NextResponse.json({ code: "unauthorized" }, { status: 401 });
  }
  const res = NextResponse.json({ operator: true, ttlS: OPS_TTL_S });
  res.cookies.set({ name: OPS_COOKIE, value: opsCookieValue(keys), httpOnly: true, sameSite: "strict", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: OPS_TTL_S });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ operator: false });
  res.cookies.set({ name: OPS_COOKIE, value: "", path: "/", maxAge: 0 });
  return res;
}
