import { NextResponse, type NextRequest } from "next/server";
import { handleAi } from "@/lib/ai/handler";
import { readingHash } from "@/lib/ledger/hash";
import { TAROT_SCHEMA, TAROT_VERSIONS, parseTarotRequest, tarotNeedsSupport, tarotPrompt, validateTarot } from "@/lib/ai/tarot-prompt";

export const maxDuration = 60;

// The question, card ids and shared notes are sent to the AI provider for this request only. The
// ledger keeps a keyed hash of the request (never its text) and the generated reading for 2 hours,
// so a retry or a reload replays it instead of paying again.
export function POST(req: NextRequest) {
  return handleAi(req, {
    purpose: "tarot",
    parse: parseTarotRequest,
    preflight: (p) => (tarotNeedsSupport(p) ? NextResponse.json({ code: "crisis" }, { status: 200 }) : null),
    build: (p) => {
      const { system, user } = tarotPrompt(p);
      return { purpose: "tarot", system, messages: [{ role: "user", content: user }], schema: TAROT_SCHEMA, schemaName: "tarot_reading", timeoutMs: 30_000 };
    },
    validate: (p) => (data) => validateTarot(data, p),
    versions: () => TAROT_VERSIONS,
    respond: (value, meta) => ({ ...value, meta: { ...meta, versions: TAROT_VERSIONS } }),
    // a pack reading only when the person chose it ("use": "paid"); never assumed
    paid: (body, p, keys) => (body.use === "paid" ? { mode: "paid_reading", readingHash: readingHash(keys.input, p) } : null),
  });
}
