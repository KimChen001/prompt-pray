// AI horoscope: request parsing, fact checks, prompt and output validation (overall review §1, §3).
// The browser sends structured facts (never birth details). The server recomputes the day's sky for
// the date and time zone and accepts only facts that match it; the prompt's fact sentences are
// written here from those facts, and the reply is checked against them (signs, houses, aspects).
// Natal positions are not sent (they would reveal the birthday), so natal-side geometry is trusted
// from the browser, while everything about the sky is verified.
import { detectCrisis } from "@/lib/safety";
import { skyForDay, dayMidpoint, type DaySky, type SkyEvent } from "@/lib/astro/sky";
import { allPositions } from "@/lib/astro/ephemeris";
import { isValidTimeZone } from "@/lib/astro/birth";
import { factLine, HOROSCOPE_RULES_VERSION } from "@/lib/astro/horoscope";
import { TRANSITING, TRANSIT_ORB, signAspect, solarHouse, type Aspect, type Fact, type HouseBasis, type NatalPoint } from "@/lib/astro/transits";
import { PLANETS, SIGNS, signOf, type Planet, type Sign } from "@/lib/astro/zodiac";
import type { Locale } from "@/lib/tarot/types";
import { addAspect, addHouse, addSign, addUncertain, CLAIM_RULES_VERSION, emptyClaimFacts, findInconsistentClaim, setAsc, type ClaimFacts } from "./claims";
import type { JsonSchema } from "./types";

// horoscope@3: the person's signs and today's sky are named apart ("your Sun sign" vs "today's Sun").
export const HOROSCOPE_PROMPT_VERSION = "horoscope@3";

export const HOROSCOPE_SCHEMA: JsonSchema = {
  type: "object",
  properties: { overall: { type: "string" }, love: { type: "string" }, work: { type: "string" } },
  required: ["overall", "love", "work"],
  additionalProperties: false,
};

/** A fact as sent over the wire: the transit Fact without its ranking weight. */
export type WireFact =
  | { kind: "aspect"; transit: Planet; aspect: Aspect; natal: NatalPoint; orb: number; sampled?: boolean }
  | { kind: "moonHouse"; house: number; basis: HouseBasis; sign: Sign }
  | { kind: "event"; event: { kind: SkyEvent["kind"]; planet?: Planet; phase?: string; sign: Sign; at: string }; house: number | null; basis: HouseBasis | null }
  | { kind: "retrograde"; planet: "mercury" | "venus" | "mars" };

export interface HoroscopeSubject {
  mode: "natal" | "sign";
  timeKnown: boolean;
  /** One sign, or both candidates when the Sun changes sign on an unknown-time birth day. */
  sun: Sign[];
  moon?: Sign[];
  rising?: Sign;
}

export interface HoroscopeRequest {
  locale: Locale;
  date: string;
  timeZone: string;
  tone: "flow" | "tension" | "focus";
  subject: HoroscopeSubject;
  facts: WireFact[];
}

export interface HoroscopeText {
  overall: string;
  love: string;
  work: string;
}

const MAX_FACTS = 8;
const MAX_SECTION_LEN = 900;
const ASPECTS: Aspect[] = ["conjunction", "sextile", "square", "trine", "opposition"];
const isSign = (v: unknown): v is Sign => SIGNS.includes(v as Sign);
const isPlanet = (v: unknown): v is Planet => PLANETS.includes(v as Planet);
const signList = (v: unknown, max: number): Sign[] | null => (Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(isSign) ? (v as Sign[]) : null);
const isHouse = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 12;

/** Turns a wire fact into the transit Fact the sentence templates expect (weight unused here). */
export function toFact(f: WireFact): Fact {
  if (f.kind === "event") {
    const e = { ...f.event, at: new Date(f.event.at) } as SkyEvent;
    return { kind: "event", event: e, house: f.house, basis: f.basis, weight: 0 };
  }
  return { ...f, weight: 0 } as Fact;
}

/** Wire form of a Fact (what the browser sends). */
export function toWire(f: Fact): WireFact {
  if (f.kind === "event") {
    const e = f.event;
    return { kind: "event", event: { kind: e.kind, ...("planet" in e ? { planet: e.planet } : {}), ...("phase" in e ? { phase: e.phase } : {}), sign: e.sign, at: e.at.toISOString() }, house: f.house, basis: f.basis };
  }
  const { weight: _w, ...rest } = f;
  void _w;
  return rest as WireFact;
}

function parseFact(v: unknown): WireFact | null {
  const f = v as Record<string, unknown>;
  if (!f || typeof f !== "object") return null;
  switch (f.kind) {
    case "aspect":
      if (!isPlanet(f.transit) || !ASPECTS.includes(f.aspect as Aspect) || !["sun", "moon", "asc"].includes(f.natal as string) || typeof f.orb !== "number" || !Number.isFinite(f.orb) || f.orb < 0) return null;
      return { kind: "aspect", transit: f.transit, aspect: f.aspect as Aspect, natal: f.natal as NatalPoint, orb: f.orb, ...(f.sampled === true ? { sampled: true } : {}) };
    case "moonHouse":
      if (!isHouse(f.house) || (f.basis !== "natal" && f.basis !== "solar") || !isSign(f.sign)) return null;
      return { kind: "moonHouse", house: f.house as number, basis: f.basis, sign: f.sign };
    case "event": {
      const e = f.event as Record<string, unknown>;
      if (!e || !["ingress", "stationRetrograde", "stationDirect", "lunation"].includes(e.kind as string) || !isSign(e.sign) || typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) return null;
      if (e.kind === "lunation" ? !["new", "firstQuarter", "full", "lastQuarter"].includes(e.phase as string) : !isPlanet(e.planet)) return null;
      if (f.house !== null && !isHouse(f.house)) return null;
      if (f.basis !== null && f.basis !== "natal" && f.basis !== "solar") return null;
      return { kind: "event", event: { kind: e.kind as SkyEvent["kind"], ...(e.planet ? { planet: e.planet as Planet } : {}), ...(e.phase ? { phase: e.phase as string } : {}), sign: e.sign, at: e.at }, house: (f.house as number | null), basis: (f.basis as HouseBasis | null) };
    }
    case "retrograde":
      return f.planet === "mercury" || f.planet === "venus" || f.planet === "mars" ? { kind: "retrograde", planet: f.planet } : null;
    default:
      return null;
  }
}

export function parseHoroscopeRequest(body: unknown): HoroscopeRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const locale = b.locale === "zh" ? "zh" : b.locale === "en" ? "en" : null;
  const date = typeof b.date === "string" && /^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
  const timeZone = typeof b.timeZone === "string" && b.timeZone.length <= 64 && isValidTimeZone(b.timeZone) ? b.timeZone : null;
  const tone = b.tone === "flow" || b.tone === "tension" || b.tone === "focus" ? b.tone : null;
  const s = (b.subject ?? {}) as Record<string, unknown>;
  const sun = signList(s.sun, 2);
  const mode = s.mode === "natal" || s.mode === "sign" ? s.mode : null;
  if (!locale || !date || !timeZone || !tone || !sun || !mode || typeof s.timeKnown !== "boolean") return null;
  const moon = s.moon === undefined ? undefined : signList(s.moon, 2);
  if (moon === null) return null;
  if (s.rising !== undefined && (!isSign(s.rising) || !s.timeKnown)) return null;
  if (!Array.isArray(b.facts) || b.facts.length === 0 || b.facts.length > MAX_FACTS) return null;
  const facts: WireFact[] = [];
  for (const v of b.facts) {
    const f = parseFact(v);
    if (!f) return null;
    facts.push(f);
  }
  return { locale, date, timeZone, tone, subject: { mode, timeKnown: s.timeKnown, sun, ...(moon ? { moon } : {}), ...(s.rising ? { rising: s.rising as Sign } : {}) }, facts };
}

/** The sky the facts must match: the day's sky at its reference moment (the local day's midpoint). */
export function referenceSky(date: string, timeZone: string): DaySky {
  return skyForDay(date, timeZone, dayMidpoint(date, timeZone));
}

/** Null when every fact matches the recomputed sky and the subject's limits; otherwise the reason. */
export function checkFacts(r: HoroscopeRequest, sky: DaySky): string | null {
  const pos = allPositions(sky.at);
  const sun = r.subject.sun.length === 1 ? r.subject.sun[0] : null;
  for (const f of r.facts) {
    if (f.kind === "aspect") {
      if (!TRANSITING.includes(f.transit) || f.orb > TRANSIT_ORB[f.transit] + 1e-6) return "aspect orb";
      if (f.natal === "asc" && !(r.subject.timeKnown && r.subject.rising)) return "aspect to an unknown Ascendant";
      if (r.subject.mode === "sign" && (f.natal !== "sun" || !sun || signAspect(sun, signOf(pos[f.transit].lon)) !== f.aspect)) return "sign aspect";
    }
    if (f.kind === "moonHouse") {
      if (f.sign !== sky.moon.placement.sign) return "moon sign";
      if (f.basis === "natal" && !r.subject.timeKnown) return "natal house without a birth time";
      if (f.basis === "solar" && (!sun || solarHouse(f.sign, sun) !== f.house)) return "solar house";
    }
    if (f.kind === "event") {
      const at = Date.parse(f.event.at);
      const match = sky.events.find((e) => e.kind === f.event.kind && e.sign === f.event.sign && Math.abs(e.at.getTime() - at) < 120e3 &&
        (e.kind === "lunation" ? e.phase === f.event.phase : e.planet === f.event.planet));
      if (!match) return "event";
      if (f.basis === "natal" && !r.subject.timeKnown) return "natal house without a birth time";
      if (f.basis === "solar" && !sun) return "solar house without a single Sun sign";
    }
    if (f.kind === "retrograde" && !sky.retrograde.includes(f.planet)) return "retrograde";
  }
  return null;
}

/**
 * What the reply may say, per source: the person's (possibly uncertain) Sun / Moon / Rising as
 * "natal", and today's sky — planet signs, events, the houses today's bodies pass through, and
 * transits to the chart — as "sky". A claim with no source wording is read as being about the sky
 * (the horoscope is about today); the person's own signs must be named as theirs ("your Sun sign").
 */
export function horoscopeClaims(r: HoroscopeRequest, sky: DaySky): ClaimFacts {
  const cf = emptyClaimFacts("sky");
  const pos = allPositions(sky.at);
  for (const p of PLANETS) addSign(cf, "sky", p, signOf(pos[p].lon));
  // Events of the local day: an ingress puts the planet in both signs today (before and after it); a
  // lunation names the Moon's sign at that moment.
  for (const e of sky.events) {
    if (e.kind === "lunation") {
      addSign(cf, "sky", "moon", e.sign);
      continue;
    }
    addSign(cf, "sky", e.planet, e.sign);
    if (e.kind === "ingress") addSign(cf, "sky", e.planet, signOf(allPositions(new Date(e.at.getTime() - 60_000))[e.planet].lon));
  }
  if (r.subject.sun.length === 1) addSign(cf, "natal", "sun", r.subject.sun[0]);
  else addUncertain(cf, "natal", "sun", r.subject.sun);
  if (r.subject.moon) {
    if (r.subject.moon.length === 1) addSign(cf, "natal", "moon", r.subject.moon[0]);
    else addUncertain(cf, "natal", "moon", r.subject.moon);
  }
  if (r.subject.rising && r.subject.timeKnown) setAsc(cf, r.subject.rising);
  // Houses today's bodies pass through, counted on the basis the fact says (birth chart or Sun sign).
  for (const f of r.facts) {
    if (f.kind === "moonHouse") addHouse(cf, "sky", "moon", f.house, undefined, f.basis);
    if (f.kind === "event" && f.house) addHouse(cf, "sky", f.event.kind === "lunation" ? "moon" : f.event.planet!, f.house, undefined, f.basis ?? "solar");
    if (f.kind === "aspect" && (f.natal !== "asc" || cf.asc)) addAspect(cf, "sky", f.transit, f.natal, f.aspect);
  }
  return cf;
}

export function horoscopePrompt(r: HoroscopeRequest): { system: string; user: string; lines: string[] } {
  const language = r.locale === "zh" ? "Simplified Chinese (natural, not translated-sounding)" : "English";
  const lines = r.facts.map((f) => factLine(toFact(f))[r.locale]);
  const en = r.facts.map((f) => factLine(toFact(f)).en);
  const system = [
    "You are MOONA, a warm, grounded astrology companion.",
    "Write today's horoscope using ONLY the sky facts provided. Do not invent planets, signs, aspects, houses, degrees or dates.",
    "Solar houses are counted from the Sun sign; call them solar houses, never birth-chart houses.",
    "Keep the person's signs and today's sky apart in every sentence: the person's are 'your Sun sign', 'your Moon' (Chinese: 你的太阳星座, 你的月亮); today's are 'today's Moon', 'the Moon today' (Chinese: 今天的月亮). Never give the person a sign from today's sky, or today's sky a sign from the person.",
    r.subject.timeKnown ? "" : "The birth time is unknown: do not name a Rising sign or any birth-chart house. If the Sun or Moon has two possible signs, name both together.",
    "Each section is 2–3 sentences, in the second person, reflective and practical. Mention at least one concrete fact per section.",
    "Never be fatalistic. Never give medical, legal or financial instructions. Never predict illness, death or pregnancy.",
    `Write in ${language}.`,
    "Return the three sections as JSON fields overall, love and work.",
  ].filter(Boolean).join("\n");
  const s = r.subject;
  const who = [`Sun ${s.sun.join(" or ")}`, s.moon && `Moon ${s.moon.join(" or ")}`, s.rising && `Rising ${s.rising}`].filter(Boolean).join(", ");
  const user = [
    `Date: ${r.date}`,
    `The person's own signs (birth chart, not today's sky): ${who}${s.mode === "sign" ? " (Sun sign only)" : s.timeKnown ? "" : " (birth time unknown)"}`,
    `Overall tone of today's aspects: ${r.tone}`,
    "Today's sky facts (most important first):",
    ...en.map((f) => `- ${f}`),
  ].join("\n");
  return { system, user, lines };
}

/** Validates model output; null when unusable, unsafe, or a claim contradicts the facts. */
export function validateHoroscope(data: unknown, claims?: ClaimFacts): HoroscopeText | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= MAX_SECTION_LEN;
  if (!ok(d.overall) || !ok(d.love) || !ok(d.work)) return null;
  const out = { overall: d.overall.trim(), love: d.love.trim(), work: d.work.trim() };
  if (Object.values(out).some((t) => detectCrisis(t))) return null;
  if (claims && Object.values(out).some((t) => findInconsistentClaim(t, claims) !== null)) return null;
  return out;
}

/**
 * Everything the saved text depends on. A saved text from other versions is kept and shown with an
 * offer to update (never regenerated automatically, which would spend money); it is re-checked against
 * the current rules first (see horoscope-day.ts).
 */
export const HOROSCOPE_VERSIONS = `${HOROSCOPE_RULES_VERSION}|${HOROSCOPE_PROMPT_VERSION}|${CLAIM_RULES_VERSION}`;
