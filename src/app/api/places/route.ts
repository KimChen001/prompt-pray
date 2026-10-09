import { NextResponse, type NextRequest } from "next/server";
import { searchPlaces } from "@/lib/astro/places";

// The search query is used only to answer this request; it is not logged or stored.
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2 || q.length > 80) {
    return NextResponse.json({ results: [] }, { status: q.length > 80 ? 400 : 200 });
  }
  const results = searchPlaces(q, 8);
  return NextResponse.json({ results }, { headers: { "Cache-Control": "public, max-age=86400" } });
}
