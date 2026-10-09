import { NextResponse, type NextRequest } from "next/server";
import { AiError, generateJson } from "@/lib/ai/provider";
import { checkAiAccess } from "@/lib/ai/guard";
import { aiErrorResponse } from "@/lib/ai/http";
import { parseTalkRequest, TALK_PROMPT_VERSION, TALK_SCHEMA, talkContext, talkNeedsSupport, talkPrompt, validateTalk } from "@/lib/ai/talk-prompt";

// Free conversation. Messages, shared notes and chart facts are used only for this request;
// nothing is logged or stored server-side. Birth date, time and place are never part of it.
export async function POST(req: NextRequest) {
  const denied = checkAiAccess(req);
  if (denied) return NextResponse.json({ code: denied }, { status: denied === "rate_limited" ? 429 : 503 });
  const parsed = parseTalkRequest(await req.json().catch(() => null));
  if (!parsed) return NextResponse.json({ code: "bad_request" }, { status: 400 });
  if (talkNeedsSupport(parsed)) return NextResponse.json({ code: "crisis" }, { status: 200 });

  try {
    const { items, claims } = talkContext(parsed);
    const { system, messages } = talkPrompt(parsed, items);
    const { value, meta } = await generateJson(
      { purpose: "talk", system, messages, schema: TALK_SCHEMA, schemaName: "talk_reply", timeoutMs: 25_000 },
      (data) => validateTalk(data, parsed, items, claims),
    );
    return NextResponse.json({ ...value, promptVersion: TALK_PROMPT_VERSION, meta: { provider: meta.provider, model: meta.model, generatedAt: meta.generatedAt } });
  } catch (e) {
    return aiErrorResponse(e instanceof AiError ? e : new AiError("upstream"));
  }
}
