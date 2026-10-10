import { NextResponse, type NextRequest } from "next/server";
import { handleAi } from "@/lib/ai/handler";
import { readingHash } from "@/lib/ledger/hash";
import { CHAT_SCHEMA, chatNeedsSupport, chatPrompt, parseChatRequest, validateChat } from "@/lib/ai/chat-prompt";
import { TAROT_VERSIONS } from "@/lib/ai/tarot-prompt";

export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
    // a pack follow-up: only about the paid reading it names, checked by the reading's hash
    paid: (body, p, keys) => (typeof body.paidReadingId === "string" && UUID.test(body.paidReadingId) ? { mode: "paid_followup", readingHash: readingHash(keys.input, p.reading), paidReadingId: body.paidReadingId } : null),
  });
}
