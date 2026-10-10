import type { NextRequest } from "next/server";
import { handleAi } from "@/lib/ai/handler";
import { NATAL_PROMPT_VERSION, NATAL_SCHEMA, natalPrompt, parseNatalRequest, validateNatal } from "@/lib/ai/natal-prompt";
import { CLAIM_RULES_VERSION } from "@/lib/ai/claims";

export const maxDuration = 60;

const VERSIONS = `${NATAL_PROMPT_VERSION}|${CLAIM_RULES_VERSION}`;

// Receives computed chart facts and themes only (no birth date, time or place). The ledger keeps a
// keyed hash of the request and the report for 2 hours, for replay.
export function POST(req: NextRequest) {
  return handleAi(req, {
    purpose: "natal",
    parse: parseNatalRequest,
    build: (p) => {
      const { system, user } = natalPrompt(p);
      return { purpose: "natal", system, messages: [{ role: "user", content: user }], schema: NATAL_SCHEMA, schemaName: "natal_report", timeoutMs: 40_000 };
    },
    validate: (p) => (data) => validateNatal(data, p),
    versions: () => VERSIONS,
    respond: (value, meta) => ({ ...value, promptVersion: NATAL_PROMPT_VERSION, meta: { ...meta, versions: VERSIONS } }),
  });
}
