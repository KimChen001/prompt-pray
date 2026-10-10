import { NextResponse, type NextRequest } from "next/server";
import { handleAi } from "@/lib/ai/handler";
import { checkFacts, HOROSCOPE_PROMPT_VERSION, HOROSCOPE_SCHEMA, HOROSCOPE_VERSIONS, horoscopeClaims, horoscopePrompt, parseHoroscopeRequest, referenceSky, validateHoroscope, type HoroscopeRequest } from "@/lib/ai/horoscope-prompt";

export const maxDuration = 60;

type Parsed = { r: HoroscopeRequest; sky: ReturnType<typeof referenceSky> };

// Request bodies (structured sky facts and sign names) are sent to the AI provider only. The sky is
// recomputed here; facts that do not match it are refused before any model call. A Sun-sign-only
// horoscope is the same for everyone with that sign on that day, so it is shared between visitors;
// anything with a Moon or Rising sign stays per visitor.
export function POST(req: NextRequest) {
  return handleAi(req, {
    purpose: "horoscope",
    parse: (body): Parsed | null => {
      const r = parseHoroscopeRequest(body);
      return r ? { r, sky: referenceSky(r.date, r.timeZone) } : null;
    },
    preflight: ({ r, sky }) => (checkFacts(r, sky) ? NextResponse.json({ code: "bad_facts" }, { status: 400 }) : null),
    build: ({ r }) => {
      const { system, user } = horoscopePrompt(r);
      return { purpose: "horoscope", system, messages: [{ role: "user", content: user }], schema: HOROSCOPE_SCHEMA, schemaName: "horoscope", timeoutMs: 20_000 };
    },
    validate: ({ r, sky }) => {
      const claims = horoscopeClaims(r, sky);
      return (data) => validateHoroscope(data, claims);
    },
    versions: () => HOROSCOPE_VERSIONS,
    canonical: ({ r }) => r,
    cacheScope: ({ r }) => (r.subject.mode === "sign" && !r.subject.moon?.length && !r.subject.rising ? "shared" : "subject"),
    respond: (value, meta, { r }) => ({ ...value, basis: horoscopePrompt(r).lines, promptVersion: HOROSCOPE_PROMPT_VERSION, versions: HOROSCOPE_VERSIONS, meta, source: meta.source }),
  });
}
