import { NextResponse, type NextRequest } from "next/server";
import { serverKeys } from "@/lib/identity/keys";
import { OPS_COOKIE, OPS_TTL_S, opsCookieValue, opsTokenMatches } from "@/lib/identity/ops";
import { netBucket } from "@/lib/identity/visitor";
import { opsBegin, opsSettle } from "@/lib/identity/ops-throttle";

// Marks this device as an operator's for 12 hours, given OPS_TOKEN (set by the team in the host's
// environment; at least 24 characters). Failed attempts are throttled per network, so guessing from
// one network can't lock the team out everywhere. There is deliberately no total cap: it would let
// anyone lock out the whole team. Guessing a 24+ character random token is infeasible either way;
// on a self-hosted server, put it behind a proxy that sets x-forwarded-for.
export async function POST(req: NextRequest) {
  const keys = serverKeys();
  if (!keys || (process.env.OPS_TOKEN ?? "").length < 24) return NextResponse.json({ code: "not_found" }, { status: 404 });
  const bucket = netBucket(req, keys);
  if (!opsBegin(bucket)) return NextResponse.json({ code: "rate_limited" }, { status: 429 });
  let ok = false;
  try {
    const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
    ok = opsTokenMatches(body?.token);
  } finally {
    opsSettle(bucket, !ok);
  }
  if (!ok) return NextResponse.json({ code: "unauthorized" }, { status: 401 });
  const res = NextResponse.json({ operator: true, ttlS: OPS_TTL_S });
  res.cookies.set({ name: OPS_COOKIE, value: opsCookieValue(keys), httpOnly: true, sameSite: "strict", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: OPS_TTL_S });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ operator: false });
  res.cookies.set({ name: OPS_COOKIE, value: "", path: "/", maxAge: 0 });
  return res;
}
