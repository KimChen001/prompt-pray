// One place that builds a day's horoscope for a person, its AI request body and its cache key
// (overall review §6). The facts use the day's fixed reference moment (sky.ts dayMidpoint), so the
// template text, the AI request and a saved AI text all refer to the same sky.
import { computeChart } from "./chart";
import { skyForDay, dayMidpoint, type DaySky } from "./sky";
import { dailyFacts, subjectFromBirth, type Fact, type Subject } from "./transits";
import { composeHoroscope, type Horoscope } from "./horoscope";
import type { BirthData } from "./birth";
import type { HouseSystem } from "./houses";
import type { Sign } from "./zodiac";
import { horoscopeClaims, toWire, validateHoroscope, type HoroscopeRequest, type HoroscopeSubject } from "@/lib/ai/horoscope-prompt";
import type { Locale } from "@/lib/tarot/types";

export type HoroscopeInput = { birth: BirthData; houseSystem: HouseSystem } | { sunSign: Sign };

export interface DayHoroscope {
  subject: Subject;
  wire: HoroscopeSubject;
  sky: DaySky;
  facts: Fact[];
  horoscope: Horoscope;
  /** Changes whenever any calculation input changes (birth details, DST choice, zone, house system, sign). */
  fingerprint: string;
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function inputFingerprint(input: HoroscopeInput): string {
  if ("sunSign" in input) return `sign:${input.sunSign}`;
  const b = input.birth;
  return `natal:${fnv(JSON.stringify([b.date, b.time ?? null, b.offsetChoice ?? null, b.place.lat, b.place.lon, b.place.tz, b.time ? input.houseSystem : "-"]))}`;
}

export function dayHoroscope(input: HoroscopeInput, localDate: string, timeZone: string): DayHoroscope {
  const sky = skyForDay(localDate, timeZone, dayMidpoint(localDate, timeZone));
  let subject: Subject;
  let wire: HoroscopeSubject;
  if ("sunSign" in input) {
    subject = { mode: "sign", sunSign: input.sunSign };
    wire = { mode: "sign", timeKnown: false, sun: [input.sunSign] };
  } else {
    subject = subjectFromBirth(input.birth, input.houseSystem);
    const b3 = computeChart(input.birth, input.houseSystem).bigThree;
    const signs = (c: { placement: { sign: Sign } | null; options: Sign[] | null }) => (c.placement ? [c.placement.sign] : c.options ?? []);
    wire = {
      mode: "natal",
      timeKnown: !!subject.natal?.timeKnown,
      sun: signs(b3.sun),
      moon: signs(b3.moon),
      ...(b3.rising?.placement ? { rising: b3.rising.placement.sign } : {}),
    };
  }
  const facts = dailyFacts(subject, sky);
  return { subject, wire, sky, facts, horoscope: composeHoroscope(facts), fingerprint: inputFingerprint(input) };
}

/**
 * Saved AI text is found again only for the same day, zone, inputs and language. The rules/prompt
 * versions it was written under are stored with it (store.ts CachedText.versions), so a version change
 * keeps the saved text and offers an update instead of silently paying for a new one.
 */
export function horoscopeCacheKey(d: DayHoroscope, localDate: string, timeZone: string, locale: Locale): string {
  return `${localDate}|${timeZone}|${d.fingerprint}|${locale}`;
}

/** Whether a text saved under earlier versions still passes the current claim checks for this day (no model call). */
export function savedTextHolds(text: { overall: string; love: string; work: string }, d: DayHoroscope, localDate: string, timeZone: string, locale: Locale): boolean {
  const claims = horoscopeClaims(horoscopeBody(d, localDate, timeZone, locale), d.sky);
  return validateHoroscope({ overall: text.overall, love: text.love, work: text.work }, claims) !== null;
}

export function horoscopeBody(d: DayHoroscope, localDate: string, timeZone: string, locale: Locale): HoroscopeRequest {
  return { locale, date: localDate, timeZone, tone: d.horoscope.tone, subject: d.wire, facts: d.horoscope.why.map((w) => toWire(w.fact)) };
}
