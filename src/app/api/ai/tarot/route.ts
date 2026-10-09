import { NextResponse, type NextRequest } from "next/server";
import { AiError, generateJson } from "@/lib/ai/provider";
import { checkAiAccess } from "@/lib/ai/guard";
import { aiErrorResponse } from "@/lib/ai/http";
import { TAROT_SCHEMA, parseTarotRequest, tarotPrompt, validateTarot } from "@/lib/ai/tarot-prompt";
import { detectCrisis } from "@/lib/safety";

// The question and card ids are used only for this request; nothing is logged or stored server-side.
export async function POST(req: NextRequest) {
  const denied = checkAiAccess(req);
  if (denied) return NextResponse.json({ code: denied }, { status: denied === "rate_limited" ? 429 : 503 });
  const parsed = parseTarotRequest(await req.json().catch(() => null));
  if (!parsed) return NextResponse.json({ code: "bad_request" }, { status: 400 });
  if (parsed.question && detectCrisis(parsed.question)) return NextResponse.json({ code: "crisis" }, { status: 200 });

  try {
    const { system, user } = tarotPrompt(parsed);
    const { value, meta } = await generateJson(
      { purpose: "tarot", system, messages: [{ role: "user", content: user }], schema: TAROT_SCHEMA, schemaName: "tarot_reading", timeoutMs: 30_000 },
      (data) => validateTarot(data, parsed),
    );
    return NextResponse.json({ ...value, meta: { provider: meta.provider, model: meta.model, generatedAt: meta.generatedAt } });
  } catch (e) {
    return aiErrorResponse(e instanceof AiError ? e : new AiError("upstream"));
  }
}
