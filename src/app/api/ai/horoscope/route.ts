import { NextResponse, type NextRequest } from "next/server";
import { AiError, generateJson } from "@/lib/ai/provider";
import { checkAiAccess } from "@/lib/ai/guard";
import { HOROSCOPE_SCHEMA, horoscopePrompt, parseHoroscopeRequest, validateHoroscope } from "@/lib/ai/horoscope-prompt";
import { aiErrorResponse } from "@/lib/ai/http";

// Request bodies (sky facts + sign names) are not logged or stored.
export async function POST(req: NextRequest) {
  const denied = checkAiAccess(req);
  if (denied) return NextResponse.json({ code: denied }, { status: denied === "rate_limited" ? 429 : 503 });
  const parsed = parseHoroscopeRequest(await req.json().catch(() => null));
  if (!parsed) return NextResponse.json({ code: "bad_request" }, { status: 400 });

  try {
    const { system, user } = horoscopePrompt(parsed);
    const { value, meta } = await generateJson(
      { purpose: "horoscope", system, messages: [{ role: "user", content: user }], schema: HOROSCOPE_SCHEMA, schemaName: "horoscope", timeoutMs: 20_000 },
      validateHoroscope,
    );
    return NextResponse.json({ ...value, meta, source: "live" });
  } catch (e) {
    return aiErrorResponse(e instanceof AiError ? e : new AiError("upstream"));
  }
}
