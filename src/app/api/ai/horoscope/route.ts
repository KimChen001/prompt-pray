import { NextResponse, type NextRequest } from "next/server";
import { AiError, generateJson } from "@/lib/ai/provider";
import { checkAiAccess } from "@/lib/ai/guard";
import { checkFacts, HOROSCOPE_PROMPT_VERSION, HOROSCOPE_SCHEMA, horoscopeClaims, horoscopePrompt, parseHoroscopeRequest, referenceSky, validateHoroscope } from "@/lib/ai/horoscope-prompt";
import { aiErrorResponse } from "@/lib/ai/http";

// Request bodies (structured sky facts + sign names) are not logged or stored. The sky is
// recomputed here; facts that don't match it are refused before any model call.
export async function POST(req: NextRequest) {
  const denied = checkAiAccess(req);
  if (denied) return NextResponse.json({ code: denied }, { status: denied === "rate_limited" ? 429 : 503 });
  const parsed = parseHoroscopeRequest(await req.json().catch(() => null));
  if (!parsed) return NextResponse.json({ code: "bad_request" }, { status: 400 });
  const sky = referenceSky(parsed.date, parsed.timeZone);
  const wrong = checkFacts(parsed, sky);
  if (wrong) return NextResponse.json({ code: "bad_facts" }, { status: 400 });

  try {
    const { system, user, lines } = horoscopePrompt(parsed);
    const claims = horoscopeClaims(parsed, sky);
    const { value, meta } = await generateJson(
      { purpose: "horoscope", system, messages: [{ role: "user", content: user }], schema: HOROSCOPE_SCHEMA, schemaName: "horoscope", timeoutMs: 20_000 },
      (data) => validateHoroscope(data, claims),
    );
    return NextResponse.json({ ...value, basis: lines, promptVersion: HOROSCOPE_PROMPT_VERSION, meta, source: "live" });
  } catch (e) {
    return aiErrorResponse(e instanceof AiError ? e : new AiError("upstream"));
  }
}
