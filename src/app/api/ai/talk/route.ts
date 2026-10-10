import { NextResponse, type NextRequest } from "next/server";
import { handleAi } from "@/lib/ai/handler";
import { parseTalkRequest, TALK_PROMPT_VERSION, TALK_SCHEMA, TALK_VERSIONS, talkContext, talkNeedsSupport, talkPrompt, validateTalk, type TalkRequest } from "@/lib/ai/talk-prompt";

export const maxDuration = 60;

type Parsed = { r: TalkRequest; ctx: ReturnType<typeof talkContext> };

// Free conversation. Messages, shared notes and chart facts are sent to the AI provider for this
// request only; birth date, time and place are never part of it. The ledger keeps a keyed hash of
// the request (never its text) and the reply for 2 hours, for replay.
export function POST(req: NextRequest) {
  return handleAi(req, {
    purpose: "talk",
    parse: (body): Parsed | null => {
      const r = parseTalkRequest(body);
      return r ? { r, ctx: talkContext(r) } : null;
    },
    preflight: ({ r }) => (talkNeedsSupport(r) ? NextResponse.json({ code: "crisis" }, { status: 200 }) : null),
    build: ({ r, ctx }) => {
      const { system, messages } = talkPrompt(r, ctx.items);
      return { purpose: "talk", system, messages, schema: TALK_SCHEMA, schemaName: "talk_reply", timeoutMs: 25_000 };
    },
    validate: ({ r, ctx }) => (data) => validateTalk(data, r, ctx.items, ctx.claims),
    versions: () => TALK_VERSIONS,
    // today's sky is part of the context, so a reply from another day is never replayed
    canonical: ({ r, ctx }) => ({ r, items: ctx.items }),
    respond: (value, meta) => ({ ...value, promptVersion: TALK_PROMPT_VERSION, meta: { ...meta, versions: TALK_VERSIONS } }),
  });
}
