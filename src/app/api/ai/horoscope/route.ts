import { NextResponse, type NextRequest } from "next/server";
import { AiError, chatJson } from "@/lib/ai/provider";
import { checkAiAccess } from "@/lib/ai/guard";
import { horoscopePrompt, parseHoroscopeRequest, validateHoroscope } from "@/lib/ai/horoscope-prompt";

// Request bodies (sky facts + sign names) are not logged or stored.
export async function POST(req: NextRequest) {
  const denied = checkAiAccess(req);
  if (denied) {
    const status = denied === "rate_limited" ? 429 : 503;
    return NextResponse.json({ code: denied }, { status });
  }
  const parsed = parseHoroscopeRequest(await req.json().catch(() => null));
  if (!parsed) return NextResponse.json({ code: "bad_request" }, { status: 400 });

  try {
    const { data, model } = await chatJson({ ...horoscopePrompt(parsed), maxTokens: 700, timeoutMs: 15_000 });
    const text = validateHoroscope(data);
    if (!text) return NextResponse.json({ code: "bad_output" }, { status: 502 });
    return NextResponse.json({ ...text, model, source: "live" });
  } catch (e) {
    const code = e instanceof AiError ? e.code : "upstream";
    return NextResponse.json({ code }, { status: code === "timeout" ? 504 : code === "unconfigured" ? 503 : 502 });
  }
}
