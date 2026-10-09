// Natal report AI: request parsing, prompt and validation (combined review: "生成与校验层").
// The browser sends computed facts + selected themes (never birth date/time/place). Validation checks
// structure, that each theme cites only its own evidence, and key-field consistency: every explicit
// "planet in sign / house / aspect / Rising" claim in the text must match the facts.
import { detectCrisis } from "@/lib/safety";
import type { L10n, Locale } from "@/lib/tarot/types";
import type { NatalFact } from "@/lib/astro/natal-facts";
import { factLabel } from "@/lib/astro/natal-text";
import { PLANETS, SIGNS, type Planet, type Sign } from "@/lib/astro/zodiac";
import { addAspect, addHouse, addSign, addUncertain, emptyClaimFacts, findInconsistentClaim, type ClaimFacts } from "./claims";
import type { Aspect } from "@/lib/astro/transits";
import type { JsonSchema } from "./types";

export const NATAL_PROMPT_VERSION = "natal-report@1";

export interface NatalThemeInput {
  id: string;
  kind: string;
  title: L10n;
  evidenceIds: string[];
  limitations: L10n[];
}

export interface NatalRequest {
  locale: Locale;
  timeKnown: boolean;
  factsVersion: string;
  themesVersion: string;
  facts: NatalFact[];
  themes: NatalThemeInput[];
}

export interface NatalText {
  themes: { id: string; text: string; evidenceIds: string[] }[];
  overview: string;
}

export const NATAL_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    themes: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" }, evidenceIds: { type: "array", items: { type: "string" } } },
        required: ["id", "text", "evidenceIds"],
        additionalProperties: false,
      },
    },
    overview: { type: "string" },
  },
  required: ["themes", "overview"],
  additionalProperties: false,
};

const ASPECTS: Aspect[] = ["conjunction", "sextile", "square", "trine", "opposition"];
const isSign = (v: unknown): v is Sign => SIGNS.includes(v as Sign);
const isPlanet = (v: unknown): v is Planet => PLANETS.includes(v as Planet);
const isStr = (v: unknown, max = 200) => typeof v === "string" && v.length > 0 && v.length <= max;
const isL10n = (v: unknown, max = 300) => !!v && typeof v === "object" && isStr((v as L10n).en, max) && isStr((v as L10n).zh, max);

/** Shape check for one fact; rejects anything the client could not have produced. */
export function validFact(f: Record<string, unknown>): boolean {
  if (!isStr(f.id, 80) || typeof f.timeIndependent !== "boolean") return false;
  switch (f.kind) {
    case "placement":
      return isPlanet(f.body) && isSign(f.sign) && Number.isInteger(f.degree) && typeof f.approximate === "boolean" && (f.house === null || Number.isInteger(f.house)) && typeof f.retrograde === "boolean";
    case "uncertainPlacement":
      return (f.body === "sun" || f.body === "moon") && Array.isArray(f.options) && f.options.length === 2 && f.options.every(isSign) && isStr(f.changesAt, 5);
    case "angle":
      return (f.body === "asc" || f.body === "mc") && isSign(f.sign) && Number.isInteger(f.degree);
    case "aspect":
      return isPlanet(f.a) && isPlanet(f.b) && ASPECTS.includes(f.aspect as Aspect) && typeof f.orb === "number" && Number.isFinite(f.orb) && f.orb >= 0 && typeof f.tight === "boolean" &&
        (f.orbRange === undefined || (Array.isArray(f.orbRange) && f.orbRange.length === 2 && f.orbRange.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) && f.orbRange[0] <= f.orbRange[1] && f.orb === f.orbRange[1]));
    case "angular":
      return isPlanet(f.body) && Number.isInteger(f.house) && (f.onAngle === null || ["asc", "mc", "dsc", "ic"].includes(f.onAngle as string));
    case "chartRuler":
      return isPlanet(f.ruler) && isSign(f.ascSign) && isSign(f.rulerSign) && Number.isInteger(f.rulerHouse);
    case "stellium":
      return Array.isArray(f.bodies) && f.bodies.every(isPlanet) && (f.scope === "sign" ? isSign(f.sign) : f.scope === "house" && Number.isInteger(f.house));
    case "balance":
      return (f.dimension === "element" || f.dimension === "modality") && isStr(f.value, 20) && (f.state === "dominant" || f.state === "absent") && typeof f.share === "number";
    default:
      return false;
  }
}

export function parseNatalRequest(body: unknown): NatalRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const locale = b.locale === "zh" ? "zh" : b.locale === "en" ? "en" : null;
  if (!locale || typeof b.timeKnown !== "boolean" || !isStr(b.factsVersion, 40) || !isStr(b.themesVersion, 40)) return null;
  if (!Array.isArray(b.facts) || b.facts.length === 0 || b.facts.length > 80 || !b.facts.every((f) => f && typeof f === "object" && validFact(f as Record<string, unknown>))) return null;
  const facts = b.facts as NatalFact[];
  const ids = new Set(facts.map((f) => f.id));
  if (ids.size !== facts.length) return null;
  if (!b.timeKnown && facts.some((f) => !f.timeIndependent || f.kind === "angle")) return null;
  if (!Array.isArray(b.themes) || b.themes.length === 0 || b.themes.length > 5) return null;
  const themes: NatalThemeInput[] = [];
  for (const t of b.themes as Record<string, unknown>[]) {
    if (!isStr(t?.id, 80) || !String(t.id).startsWith("theme.") || !isStr(t.kind, 20) || !isL10n(t.title)) return null;
    if (!Array.isArray(t.evidenceIds) || t.evidenceIds.length === 0 || !t.evidenceIds.every((id) => typeof id === "string" && ids.has(id))) return null;
    if (!Array.isArray(t.limitations) || !t.limitations.every((l) => isL10n(l, 400))) return null;
    themes.push({ id: t.id as string, kind: t.kind as string, title: t.title as L10n, evidenceIds: t.evidenceIds as string[], limitations: t.limitations as L10n[] });
  }
  if (new Set(themes.map((t) => t.id)).size !== themes.length) return null;
  return { locale, timeKnown: b.timeKnown, factsVersion: b.factsVersion as string, themesVersion: b.themesVersion as string, facts, themes };
}

export function natalPrompt(r: NatalRequest): { system: string; user: string } {
  const language = r.locale === "zh" ? "Simplified Chinese (natural, not translated-sounding)" : "English";
  const byId = new Map(r.facts.map((f) => [f.id, f]));
  const system = [
    "You are MOONA, a warm, grounded astrologer writing a birth-chart reading.",
    "Write ONLY from the facts listed under each theme. Do not add, compute or change any planet, sign, degree, house, aspect or angle.",
    "This is symbolic interpretation of tendencies, not prediction and not a verdict on who someone is. Use 'may', 'tends to', 'can'.",
    "You know nothing about this person's life: do not invent experiences, relationships, jobs or events.",
    r.timeKnown ? "" : "The birth time is unknown: do not name a Rising sign or any house placement (you may say they need a birth time).",
    "Do not quote degrees or orbs. Respect each theme's limitations. Never give medical, legal or financial instructions.",
    "If a Sun or Moon sign is uncertain, always name both possible signs together.",
    "For each theme: one readable paragraph (3–4 sentences) and evidenceIds = the fact ids from THAT theme you relied on. Then an overview (2–3 sentences) connecting the themes without introducing new placements.",
    `Write in ${language}. Return JSON with themes (id, text, evidenceIds) in the given order, and overview.`,
  ].filter(Boolean).join("\n");
  const user = r.themes
    .map((t, i) => {
      const ev = t.evidenceIds.map((id) => `  - [${id}] ${factLabel(byId.get(id)!).en}`).join("\n");
      const lim = t.limitations.length ? `\n  limitations: ${t.limitations.map((l) => l.en).join(" ")}` : "";
      return `Theme ${i + 1} (id: ${t.id}): ${t.title.en}\n  evidence:\n${ev}${lim}`;
    })
    .join("\n\n");
  return { system, user: `Birth time known: ${r.timeKnown ? "yes" : "no"}\n\n${user}` };
}

// ---- key-field consistency (shared checker in claims.ts) ----

/** The claim facts a natal request supports: its placements, angles, houses (time known) and aspects. */
export function natalClaimFacts(r: Pick<NatalRequest, "facts" | "timeKnown">): ClaimFacts {
  const cf = emptyClaimFacts();
  for (const f of r.facts) {
    if (f.kind === "placement") {
      addSign(cf, f.body, f.sign);
      if (f.house) addHouse(cf, f.body, f.house);
    }
    if (f.kind === "uncertainPlacement") addUncertain(cf, f.body, f.options);
    if (f.kind === "angle" && f.body === "asc") cf.asc = f.sign;
    if (f.kind === "aspect") addAspect(cf, f.a, f.b, f.aspect);
  }
  // With a birth time any house may be discussed (planets only in their own); without one, none.
  if (r.timeKnown) for (let h = 1; h <= 12; h++) cf.anyHouse.add(h);
  if (!r.timeKnown) cf.asc = null;
  return cf;
}

/** Returns the first claim that contradicts the facts (or overstates an uncertain one), or null. */
export function inconsistentClaim(text: string, r: NatalRequest): string | null {
  return findInconsistentClaim(text, natalClaimFacts(r));
}

export function validateNatal(data: unknown, r: NatalRequest): NatalText | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.overview !== "string" || !d.overview.trim() || d.overview.length > 1500) return null;
  if (!Array.isArray(d.themes) || d.themes.length !== r.themes.length) return null;
  const wanted = new Map(r.themes.map((t) => [t.id, t]));
  const out: NatalText["themes"] = [];
  for (const t of d.themes as Record<string, unknown>[]) {
    const theme = typeof t?.id === "string" ? wanted.get(t.id) : undefined;
    if (!theme || out.some((o) => o.id === theme.id)) return null;
    if (typeof t.text !== "string" || !t.text.trim() || t.text.length > 1500) return null;
    if (!Array.isArray(t.evidenceIds) || t.evidenceIds.length === 0 || !t.evidenceIds.every((id) => typeof id === "string" && theme.evidenceIds.includes(id))) return null;
    out.push({ id: theme.id, text: t.text.trim(), evidenceIds: [...new Set(t.evidenceIds as string[])] });
  }
  // keep the requested order
  out.sort((a, b) => r.themes.findIndex((t) => t.id === a.id) - r.themes.findIndex((t) => t.id === b.id));
  const texts = [d.overview, ...out.map((t) => t.text)];
  if (texts.some((t) => inconsistentClaim(t, r) !== null || detectCrisis(t))) return null;
  return { themes: out, overview: d.overview.trim() };
}
