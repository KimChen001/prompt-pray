// Today's sky for a user's local day (plan v0.2 §3.3): Moon sign and phase, Sun sign,
// sign changes, retrograde stations and lunar phases that happen during that day.
// Verified against Swiss Ephemeris in tests/sky.test.ts.
import * as A from "astronomy-engine";
import { longitude, moonPhase, speed } from "./ephemeris";
import { resolveLocal } from "./birth";
import { parseLocalDate, type LocalDate } from "@/lib/time";
import { PLANETS, placement, signOf, type Placement, type Planet, type Sign } from "./zodiac";

export type PhaseName = "new" | "waxingCrescent" | "firstQuarter" | "waxingGibbous" | "full" | "waningGibbous" | "lastQuarter" | "waningCrescent";
const PHASES: PhaseName[] = ["new", "waxingCrescent", "firstQuarter", "waxingGibbous", "full", "waningGibbous", "lastQuarter", "waningCrescent"];

/** Eight 45° bins centred on New (0°), First Quarter (90°), Full (180°), Last Quarter (270°). */
export function phaseName(angle: number): PhaseName {
  return PHASES[Math.floor((((angle + 22.5) % 360) + 360) % 360 / 45)];
}

export type SkyEvent =
  | { kind: "ingress"; planet: Planet; sign: Sign; at: Date }
  | { kind: "stationRetrograde" | "stationDirect"; planet: Planet; sign: Sign; at: Date }
  | { kind: "lunation"; phase: "new" | "firstQuarter" | "full" | "lastQuarter"; sign: Sign; at: Date };

export interface DaySky {
  localDate: LocalDate;
  timeZone: string;
  at: Date; // the instant used for "current" Moon and Sun
  moon: { placement: Placement; phase: PhaseName; angle: number; illumination: number };
  sun: Placement;
  events: SkyEvent[];
  retrograde: Planet[];
  next: { phase: "new" | "full"; at: Date; sign: Sign }[];
}

function startOfLocalDay(date: LocalDate, tz: string): Date {
  const r = resolveLocal(date, "00:00", tz);
  return r.status === "ok" ? r.result.utc : r.status === "ambiguous" ? r.options[0].utc : r.suggestion.utc;
}

export function nextLocalDate(date: LocalDate): LocalDate {
  const { year, month, day } = parseLocalDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + 1)); // calendar arithmetic only; no time zone involved
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * The fixed reference moment for one local day's facts (the daily horoscope): halfway between its
 * two local midnights. Fixed, so the same day always yields the same facts and a saved text never
 * drifts away from the sky it was written from. (The "Today's sky" panel uses the live moment.)
 */
export function dayMidpoint(localDate: LocalDate, timeZone: string): Date {
  const start = startOfLocalDay(localDate, timeZone).getTime();
  const end = startOfLocalDay(nextLocalDate(localDate), timeZone).getTime();
  return new Date((start + end) / 2);
}

/** Bisect for the instant where `changed(t)` flips from false to true. */
function bisect(lo: number, hi: number, changed: (t: number) => boolean, precisionMs = 20e3): Date {
  while (hi - lo > precisionMs) {
    const mid = (lo + hi) / 2;
    if (changed(mid)) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

const QUARTER: ("new" | "firstQuarter" | "full" | "lastQuarter")[] = ["new", "firstQuarter", "full", "lastQuarter"];
const SLOW: Planet[] = ["mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto"];

/**
 * @param now The current instant; used for the "current" Moon when it falls inside the day,
 *            otherwise the day's local noon is used.
 */
export function skyForDay(localDate: LocalDate, timeZone: string, now: Date = new Date()): DaySky {
  const start = startOfLocalDay(localDate, timeZone).getTime();
  const end = startOfLocalDay(nextLocalDate(localDate), timeZone).getTime();
  const at = now.getTime() >= start && now.getTime() < end ? now : new Date((start + end) / 2);

  const events: SkyEvent[] = [];

  // Sign changes (any body). Over one day each body changes sign at most once.
  for (const p of PLANETS) {
    const s0 = signOf(longitude(p, new Date(start)));
    const s1 = signOf(longitude(p, new Date(end)));
    if (s0 !== s1) {
      const t = bisect(start, end, (ms) => signOf(longitude(p, new Date(ms))) !== s0);
      events.push({ kind: "ingress", planet: p, sign: s1, at: t });
    }
  }

  // Retrograde / direct stations: the sign of daily motion flips.
  for (const p of SLOW) {
    const v0 = speed(p, new Date(start));
    const v1 = speed(p, new Date(end));
    if (Math.sign(v0) !== Math.sign(v1)) {
      const t = bisect(start, end, (ms) => Math.sign(speed(p, new Date(ms))) !== Math.sign(v0), 60e3);
      events.push({ kind: v1 < 0 ? "stationRetrograde" : "stationDirect", planet: p, sign: signOf(longitude(p, t)), at: t });
    }
  }

  // Lunar quarters inside the day.
  let q = A.SearchMoonQuarter(A.MakeTime(new Date(start)));
  while (q.time.date.getTime() < end) {
    const t = q.time.date;
    events.push({ kind: "lunation", phase: QUARTER[q.quarter], sign: signOf(longitude("moon", t)), at: t });
    q = A.NextMoonQuarter(q);
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime());

  const retrograde = SLOW.filter((p) => speed(p, at) < 0);
  const mp = moonPhase(at);
  const next = ([0, 180] as const)
    .map((target) => {
      const t = A.SearchMoonPhase(target, A.MakeTime(at), 40)!.date;
      return { phase: target === 0 ? ("new" as const) : ("full" as const), at: t, sign: signOf(longitude("moon", t)) };
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  return {
    localDate,
    timeZone,
    at,
    moon: { placement: placement(longitude("moon", at)), phase: phaseName(mp.angle), angle: mp.angle, illumination: mp.illumination },
    sun: placement(longitude("sun", at)),
    events,
    retrograde,
    next,
  };
}
