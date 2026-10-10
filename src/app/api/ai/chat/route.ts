import { NextResponse, type NextRequest } from "next/server";
import { handleAi } from "@/lib/ai/handler";
import { CHAT_SCHEMA, chatNeedsSupport, chatPrompt, parseChatRequest, validateChat } from "@/lib/ai/chat-prompt";
import { TAROT_VERSIONS } from "@/lib/ai/tarot-prompt";

export const maxDuration = 60;

// Messages and the reading are sent to the AI provider for this request only. The ledger keeps a
// keyed hash of the request (never its text) and the reply for 2 hours, for replay.
export function POST(req: NextRequest) {
  return handleAi(req, {
    purpose: "chat",
    parse: parseChatRequest,
    preflight: (p) => (chatNeedsSupport(p) ? NextResponse.json({ code: "crisis" }, { status: 200 }) : null),
    build: (p) => {
      const { system, messages } = chatPrompt(p);
      return { purpose: "chat", system, messages, schema: CHAT_SCHEMA, schemaName: "chat_reply", timeoutMs: 25_000 };
    },
    validate: (p) => (data) => validateChat(data, p),
    versions: () => TAROT_VERSIONS,
    respond: (value, meta) => ({ ...value, meta: { ...meta, versions: TAROT_VERSIONS } }),
  });
}
