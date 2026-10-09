import { NextResponse, type NextRequest } from "next/server";
import { AiError, generateJson } from "@/lib/ai/provider";
import { checkAiAccess } from "@/lib/ai/guard";
import { aiErrorResponse } from "@/lib/ai/http";
import { NATAL_PROMPT_VERSION, NATAL_SCHEMA, natalPrompt, parseNatalRequest, validateNatal } from "@/lib/ai/natal-prompt";

// Receives computed chart facts and themes only (no birth date, time or place). Nothing is stored server-side.
export async function POST(req: NextRequest) {
  const denied = checkAiAccess(req);
  if (denied) return NextResponse.json({ code: denied }, { status: denied === "rate_limited" ? 429 : 503 });
  const parsed = parseNatalRequest(await req.json().catch(() => null));
  if (!parsed) return NextResponse.json({ code: "bad_request" }, { status: 400 });

  try {
    const { system, user } = natalPrompt(parsed);
    const { value, meta } = await generateJson(
      { purpose: "natal", system, messages: [{ role: "user", content: user }], schema: NATAL_SCHEMA, schemaName: "natal_report", timeoutMs: 40_000, maxOutputTokens: undefined },
      (data) => validateNatal(data, parsed),
    );
    return NextResponse.json({ ...value, promptVersion: NATAL_PROMPT_VERSION, meta: { provider: meta.provider, model: meta.model, generatedAt: meta.generatedAt } });
  } catch (e) {
    return aiErrorResponse(e instanceof AiError ? e : new AiError("upstream"));
  }
}
