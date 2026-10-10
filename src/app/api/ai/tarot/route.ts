import { NextResponse, type NextRequest } from "next/server";
import { handleAi } from "@/lib/ai/handler";
import { readingHash } from "@/lib/ledger/hash";
import { TAROT_SCHEMA, TAROT_VERSIONS, parseTarotRequest, tarotNeedsSupport, tarotPrompt, validateTarot } from "@/lib/ai/tarot-prompt";

export const maxDuration = 60;

const DRAW_ID = /^[A-Za-z0-9_-]{1,80}$/;

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
    // a pack reading only when the person chose it ("use": "paid"); never assumed. drawId is the saved
    // reading's own id: one pack reading per draw (the handler refuses a pack reading without it)
    paid: (body, p, keys) => (body.use === "paid" ? { mode: "paid_reading", readingHash: readingHash(keys.input, p), drawId: typeof body.drawId === "string" && DRAW_ID.test(body.drawId) ? body.drawId : undefined } : null),
  });
}
