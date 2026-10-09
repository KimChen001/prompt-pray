// Natal report AI: request parsing, prompt and validation (combined review: "生成与校验层").
// The browser sends computed facts + selected themes (never birth date/time/place). Validation checks
// structure, that each theme cites only its own evidence, and key-field consistency: every explicit
// "planet in sign / house / aspect / Rising" claim in the text must match the facts.
import { detectCrisis } from "@/lib/safety";
import type { L10n, Locale } from "@/lib/tarot/types";
import type { NatalFact } from "@/lib/astro/natal-facts";
import { factLabel } from "@/lib/astro/natal-text";
import { PLANETS, SIGNS, SIGN_INFO, PLANET_NAME, type Planet, type Sign } from "@/lib/astro/zodiac";
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
function validFact(f: Record<string, unknown>): boolean {
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

// ---- key-field consistency ----

const EN_PLANET = PLANETS.map((p) => PLANET_NAME[p].en).join("|");
const EN_SIGN = SIGNS.map((s) => SIGN_INFO[s].name.en).join("|");
const ZH_PLANET = PLANETS.map((p) => PLANET_NAME[p].zh).join("|");
const ZH_SIGN = SIGNS.map((s) => SIGN_INFO[s].name.zh).join("|");
const enPlanet = (name: string) => PLANETS.find((p) => PLANET_NAME[p].en.toLowerCase() === name.toLowerCase())!;
const zhPlanet = (name: string) => PLANETS.find((p) => PLANET_NAME[p].zh === name)!;
const enSign = (name: string) => SIGNS.find((s) => SIGN_INFO[s].name.en.toLowerCase() === name.toLowerCase())!;
const zhSign = (name: string) => SIGNS.find((s) => SIGN_INFO[s].name.zh === name)!;
const EN_ASPECT: [RegExp, Aspect][] = [
  [/^conjunct|^conjunction/i, "conjunction"], [/^sextile/i, "sextile"], [/^square/i, "square"], [/^trine/i, "trine"], [/^oppos/i, "opposition"],
];
const ZH_ASPECT: Record<string, Aspect> = { 合相: "conjunction", 六分相: "sextile", 四分相: "square", 三分相: "trine", 对分相: "opposition" };

/** Returns the first claim that contradicts the facts (or overstates an uncertain one), or null. */
export function inconsistentClaim(text: string, r: NatalRequest): string | null {
  const signs = new Map<Planet, Set<Sign>>();
  const houses = new Map<Planet, number>();
  const aspects = new Set<string>();
  let asc: Sign | null = null;
  for (const f of r.facts) {
    if (f.kind === "placement") {
      signs.set(f.body, new Set([f.sign]));
      if (f.house) houses.set(f.body, f.house);
    }
    if (f.kind === "uncertainPlacement") signs.set(f.body, new Set(f.options));
    if (f.kind === "angle" && f.body === "asc") asc = f.sign;
    if (f.kind === "aspect") aspects.add(`${f.a}|${f.b}|${f.aspect}`).add(`${f.b}|${f.a}|${f.aspect}`);
  }
  // An uncertain Sun/Moon may only be named together with its other possible sign.
  const mentions = (s: Sign) => new RegExp(`\\b${SIGN_INFO[s].name.en}\\b`, "i").test(text) || text.includes(SIGN_INFO[s].name.zh);
  const signOk = (p: Planet, s: Sign) => {
    const set = signs.get(p);
    if (!set) return true;
    return set.has(s) && (set.size === 1 || [...set].every(mentions));
  };
  const aspectOk = (a: Planet, b: Planet, asp: Aspect) => aspects.has(`${a}|${b}|${asp}`);
  const ascOk = (s: Sign) => r.timeKnown && asc === s;
  const houseOk = (p: Planet | null, h: number) => r.timeKnown && (p === null || !houses.has(p) || houses.get(p) === h);

  // English
  for (const m of text.matchAll(new RegExp(`\\b(${EN_PLANET})\\s+in\\s+(?:the\\s+sign\\s+of\\s+)?(${EN_SIGN})\\b`, "gi"))) {
    if (!signOk(enPlanet(m[1]), enSign(m[2]))) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`\\b(${EN_SIGN})\\s+(${EN_PLANET}|Rising|Ascendant)\\b`, "gi"))) {
    const s = enSign(m[1]);
    if (/^(rising|ascendant)$/i.test(m[2]) ? !ascOk(s) : !signOk(enPlanet(m[2]), s)) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`\\b(?:Rising|Ascendant)(?:\\s+sign)?\\s+(?:is\\s+)?(?:in\\s+)?(${EN_SIGN})\\b`, "gi"))) {
    if (!ascOk(enSign(m[1]))) return m[0];
  }
  for (const m of text.matchAll(/\b(?:(\d{1,2})(?:st|nd|rd|th)\s+house|house\s+(\d{1,2}))\b/gi)) {
    const before = text.slice(Math.max(0, m.index! - 40), m.index);
    const pm = before.match(new RegExp(`\\b(${EN_PLANET})\\b(?:\\s+(?:is|sits|lies|falls|placed|located|in|through|your|the))*\\s*$`, "i"));
    if (!houseOk(pm ? enPlanet(pm[1]) : null, Number(m[1] ?? m[2]))) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`\\b(${EN_PLANET})\\s+(conjunct(?:ion with|s)?|sextiles?|squares?|trines?|oppos(?:ite|es|ition to)|in opposition to)\\s+(?:your\\s+|natal\\s+|the\\s+)?(${EN_PLANET})\\b`, "gi"))) {
    const asp = EN_ASPECT.find(([re]) => re.test(m[2]))?.[1] ?? "opposition";
    if (!aspectOk(enPlanet(m[1]), enPlanet(m[3]), asp)) return m[0];
  }

  // Chinese
  for (const m of text.matchAll(new RegExp(`(${ZH_PLANET})(?:落在|位于|落入|在)(${ZH_SIGN})`, "g"))) {
    if (!signOk(zhPlanet(m[1]), zhSign(m[2]))) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`(${ZH_SIGN})(${ZH_PLANET}|上升)`, "g"))) {
    const s = zhSign(m[1]);
    if (m[2] === "上升" ? !ascOk(s) : !signOk(zhPlanet(m[2]), s)) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`上升(?:点|星座)?(?:是|为|在|落在|位于)(${ZH_SIGN})`, "g"))) {
    if (!ascOk(zhSign(m[1]))) return m[0];
  }
  for (const m of text.matchAll(/第\s*(\d{1,2})\s*宫/g)) {
    const before = text.slice(Math.max(0, m.index! - 8), m.index);
    const pm = before.match(new RegExp(`(${ZH_PLANET})(?:落在|位于|落入|在)?$`));
    if (!houseOk(pm ? zhPlanet(pm[1]) : null, Number(m[1]))) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`(${ZH_PLANET})(合相|六分相|四分相|三分相|对分相)(${ZH_PLANET})`, "g"))) {
    if (!aspectOk(zhPlanet(m[1]), zhPlanet(m[3]), ZH_ASPECT[m[2]])) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`(${ZH_PLANET})(?:与|和|跟)(${ZH_PLANET})(?:之间)?(?:形成|呈|构成)?(?:了)?(合相|六分相|四分相|三分相|对分相)`, "g"))) {
    if (!aspectOk(zhPlanet(m[1]), zhPlanet(m[2]), ZH_ASPECT[m[3]])) return m[0];
  }
  // Degrees and orbs are not quoted in prose (the fact cards show them).
  if (/\d\s*°/.test(text)) return "quotes a degree";
  return null;
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
