import { NextResponse, type NextRequest } from "next/server";
import { checkAiAccess } from "@/lib/ai/guard";
import { serverKeys } from "@/lib/identity/keys";
import { ensureVisitor } from "@/lib/identity/visitor";
import { getLedger } from "@/lib/ledger/factory";

// Sets this browser's visitor cookie before its first AI request (lib/ai/client.ts calls it once per
// page load). Without it, a first request sent twice (a double tap, a retry after a lost response)
// would mint two visitors and pay twice. Same gates as the AI routes; minting counts against the
// event's mint caps; a browser that already has a cookie costs nothing.
export async function POST(req: NextRequest) {
  const denied = checkAiAccess(req);
  if (denied) return NextResponse.json({ code: denied }, { status: 503 });
  const keys = serverKeys();
  if (!keys) return NextResponse.json({ code: "misconfigured" }, { status: 503 });
  const got = await getLedger();
  if (!got.ok) return NextResponse.json({ code: "ledger" }, { status: 503 });
  try {
    const visitor = await ensureVisitor(req, got.ledger, keys);
    if ("denied" in visitor) return NextResponse.json({ code: visitor.denied === "plan_unsynced" ? "unconfigured" : "visitor_cap" }, { status: visitor.denied === "plan_unsynced" ? 503 : 429 });
    // "known" when the request already carried this site's cookie, "new" when one was just minted: the
    // client asks once more after "new" to learn whether the browser keeps it
    const res = new NextResponse(null, { status: 204, headers: { "x-moona-visitor": visitor.set ? "new" : "known" } });
    if (visitor.set) res.cookies.set({ name: visitor.set.name, value: visitor.set.value, ...visitor.set.options });
    return res;
  } catch {
    return NextResponse.json({ code: "ledger" }, { status: 503 });
  }
}
