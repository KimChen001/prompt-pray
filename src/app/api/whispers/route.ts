import { NextResponse, type NextRequest } from "next/server";
import { checkWallPost } from "@/lib/whispers/policy";

// The shared Whispers wall is not live: there is no database, moderation queue or retention policy
// yet. This endpoint stores nothing. It answers 501 so no client can mistake it for a working wall,
// and it already applies the agreed post rules so they can be tested before a backend exists.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  const check = typeof body?.text === "string" ? checkWallPost(body.text) : ({ ok: false, reason: "empty" } as const);
  return NextResponse.json({ code: "not_live", check: check.ok ? { ok: true } : check }, { status: 501 });
}

export async function GET() {
  return NextResponse.json({ code: "not_live" }, { status: 501 });
}
