import { NextResponse, type NextRequest } from "next/server";
import { AiError, generateJson } from "@/lib/ai/provider";
import { checkAiAccess } from "@/lib/ai/guard";
import { aiErrorResponse } from "@/lib/ai/http";
import { CHAT_SCHEMA, chatNeedsSupport, chatPrompt, parseChatRequest, validateChat } from "@/lib/ai/chat-prompt";
import { TAROT_VERSIONS } from "@/lib/ai/tarot-prompt";

// Messages are used only for this request; nothing is logged or stored server-side.
export async function POST(req: NextRequest) {
  const denied = checkAiAccess(req);
  if (denied) return NextResponse.json({ code: denied }, { status: denied === "rate_limited" ? 429 : 503 });
  const parsed = parseChatRequest(await req.json().catch(() => null));
  if (!parsed) return NextResponse.json({ code: "bad_request" }, { status: 400 });
  if (chatNeedsSupport(parsed)) return NextResponse.json({ code: "crisis" }, { status: 200 });

  try {
    const { system, messages } = chatPrompt(parsed);
    const { value, meta } = await generateJson(
      { purpose: "chat", system, messages, schema: CHAT_SCHEMA, schemaName: "chat_reply", timeoutMs: 25_000 },
      (data) => validateChat(data, parsed),
    );
    return NextResponse.json({ ...value, meta: { provider: meta.provider, model: meta.model, generatedAt: meta.generatedAt, versions: TAROT_VERSIONS } });
  } catch (e) {
    return aiErrorResponse(e instanceof AiError ? e : new AiError("upstream"));
  }
}
