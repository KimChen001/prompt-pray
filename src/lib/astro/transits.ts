// Transits for the daily horoscope (plan v0.2 §3.3): how today's real sky relates to a person.
// Two modes:
//  - natal: the person has birth details → degree-based aspects to natal Sun/Moon/Ascendant, natal houses.
//  - sign:  only a Sun sign → sign-based aspects and solar houses (the Sun sign is the 1st house).
// Unknown birth time (overall review §3) keeps the same rules as the chart and the natal facts:
//  - natal Sun and Moon are sampled hourly across the birth day; an aspect counts only if it holds at
//    every sample (its orb is the widest sampled one),
//  - there is no Ascendant and there are no natal houses: houses are solar houses, labelled as such,
//    and if the Sun itself changes sign that day there are no house facts at all,
//  - a Sun that changes sign that day keeps both candidate signs.
import { allPositions } from "./ephemeris";
import { houseOf } from "./houses";
import { birthDayRange, computeChart } from "./chart";
import { SIGNS, norm360, signOf, type Planet, type Sign } from "./zodiac";
import type { BirthData } from "./birth";
import type { HouseSystem } from "./houses";
import type { DaySky } from "./sky";

export const TRANSIT_RULES_VERSION = "transits@2";

export type Aspect = "conjunction" | "sextile" | "square" | "trine" | "opposition";
export type Tone = "flow" | "tension" | "focus";
export const ASPECT_TONE: Record<Aspect, Tone> = { conjunction: "focus", sextile: "flow", trine: "flow", square: "tension", opposition: "tension" };
const ASPECT_ANGLE: Record<Aspect, number> = { conjunction: 0, sextile: 60, square: 90, trine: 120, opposition: 180 };

export const TRANSITING: Planet[] = ["sun", "moon", "mercury", "venus", "mars"];
export type NatalPoint = "sun" | "moon" | "asc";
export const TRANSIT_ORB: Record<Planet, number> = { sun: 3, moon: 6, mercury: 3, venus: 3, mars: 3, jupiter: 2, saturn: 2, uranus: 2, neptune: 2, pluto: 2 };
/** "natal" = a house from the birth chart; "solar" = counted from the Sun sign. */
export type HouseBasis = "natal" | "solar";

export type Fact =
  | { kind: "aspect"; transit: Planet; aspect: Aspect; natal: NatalPoint; orb: number; weight: number; sampled?: boolean }
  | { kind: "moonHouse"; house: number; basis: HouseBasis; sign: Sign; weight: number }
  | { kind: "event"; event: DaySky["events"][number]; house: number | null; basis: HouseBasis | null; weight: number }
  | { kind: "retrograde"; planet: "mercury" | "venus" | "mars"; weight: number };

export interface Subject {
  mode: "natal" | "sign";
  /** The Sun sign, or null when it changes on an unknown-time birth day (see sunOptions). */
  sunSign: Sign | null;
  /** Both candidate Sun signs when the Sun changes sign that day and the time is unknown. */
  sunOptions?: Sign[];
  natal?: {
    timeKnown: boolean;
    /** One longitude per point with a birth time; hourly samples across the birth day without one. */
    points: Partial<Record<NatalPoint, number[]>>;
    cusps: number[] | null;
  };
}

/** Builds the transit subject from birth details, keeping every unknown-time limitation. */
export function subjectFromBirth(birth: BirthData, houseSystem: HouseSystem): Subject {
  const chart = computeChart(birth, houseSystem);
  if (chart.timeKnown) {
    return {
      mode: "natal",
      sunSign: chart.positions.sun.placement.sign,
      natal: { timeKnown: true, points: { sun: [chart.positions.sun.lon], moon: [chart.positions.moon.lon], ...(chart.asc ? { asc: [chart.asc.lon] } : {}) }, cusps: chart.cusps },
    };
  }
  const { start, end } = birthDayRange(birth);
  const samples = Array.from({ length: 25 }, (_, i) => allPositions(new Date(start.getTime() + ((end.getTime() - start.getTime()) * i) / 24)));
  const sun = chart.bigThree.sun;
  return {
    mode: "natal",
    sunSign: sun.placement?.sign ?? null,
    ...(sun.options ? { sunOptions: sun.options } : {}),
    natal: { timeKnown: false, points: { sun: samples.map((p) => p.sun.lon), moon: samples.map((p) => p.moon.lon) }, cusps: null },
  };
}

/** Signed separation folded to 0–180. */
const separation = (a: number, b: number) => {
  const d = Math.abs(norm360(a - b));
  return d > 180 ? 360 - d : d;
};

export function aspectBetween(lonA: number, lonB: number, orb: number): { aspect: Aspect; orb: number } | null {
  const sep = separation(lonA, lonB);
  for (const [aspect, angle] of Object.entries(ASPECT_ANGLE) as [Aspect, number][]) {
    if (Math.abs(sep - angle) <= orb) return { aspect, orb: +Math.abs(sep - angle).toFixed(2) };
  }
  return null;
}

/** The aspect that holds against every sample, with the widest orb; null if any sample breaks it. */
export function aspectThroughout(lon: number, samples: number[], orb: number): { aspect: Aspect; orb: number } | null {
  let worst: { aspect: Aspect; orb: number } | null = null;
  for (const s of samples) {
    const hit = aspectBetween(lon, s, orb);
    if (!hit || (worst && hit.aspect !== worst.aspect)) return null;
    if (!worst || hit.orb > worst.orb) worst = hit;
  }
  return worst;
}

/** Whole-sign aspect between two signs (sign mode). */
export function signAspect(a: Sign, b: Sign): Aspect | null {
  const d = (SIGNS.indexOf(b) - SIGNS.indexOf(a) + 12) % 12;
  return ({ 0: "conjunction", 2: "sextile", 10: "sextile", 3: "square", 9: "square", 4: "trine", 8: "trine", 6: "opposition" } as Record<number, Aspect>)[d] ?? null;
}

/** Solar house: the Sun sign is house 1. */
export function solarHouse(sign: Sign, sunSign: Sign): number {
  return ((SIGNS.indexOf(sign) - SIGNS.indexOf(sunSign) + 12) % 12) + 1;
}

const TRANSIT_WEIGHT: Record<Planet, number> = { sun: 3, moon: 2, mercury: 2, venus: 2.5, mars: 2.5, jupiter: 1, saturn: 1, uranus: 1, neptune: 1, pluto: 1 };
const POINT_WEIGHT: Record<NatalPoint, number> = { sun: 1.2, moon: 1.1, asc: 1 };

/** All facts for the day, strongest first. Deterministic for the same inputs. */
export function dailyFacts(subject: Subject, sky: DaySky): Fact[] {
  const now = allPositions(sky.at);
  const facts: Fact[] = [];
  const natalHouses = subject.mode === "natal" && subject.natal?.cusps ? subject.natal.cusps : null;
  const houseFor = (lon: number): { house: number; basis: HouseBasis } | null =>
    natalHouses ? { house: houseOf(lon, natalHouses), basis: "natal" } : subject.sunSign ? { house: solarHouse(signOf(lon), subject.sunSign), basis: "solar" } : null;

  if (subject.mode === "natal" && subject.natal) {
    for (const t of TRANSITING) {
      for (const p of ["sun", "moon", "asc"] as NatalPoint[]) {
        const lons = subject.natal.points[p];
        if (!lons?.length) continue;
        const hit = lons.length === 1 ? aspectBetween(now[t].lon, lons[0], TRANSIT_ORB[t]) : aspectThroughout(now[t].lon, lons, TRANSIT_ORB[t]);
        if (hit) facts.push({ kind: "aspect", transit: t, natal: p, aspect: hit.aspect, orb: hit.orb, weight: TRANSIT_WEIGHT[t] * POINT_WEIGHT[p] * (1 - hit.orb / (TRANSIT_ORB[t] + 1)), ...(lons.length > 1 ? { sampled: true } : {}) });
      }
    }
  } else if (subject.sunSign) {
    for (const t of TRANSITING) {
      if (t === "sun") continue; // the Sun is in its own sign once a year; skip the trivial self-aspect
      const a = signAspect(subject.sunSign, signOf(now[t].lon));
      if (a) facts.push({ kind: "aspect", transit: t, natal: "sun", aspect: a, orb: 0, weight: TRANSIT_WEIGHT[t] * 0.8 });
    }
  }

  const moonHouse = houseFor(sky.moon.placement.lon);
  if (moonHouse) facts.push({ kind: "moonHouse", house: moonHouse.house, basis: moonHouse.basis, sign: sky.moon.placement.sign, weight: 1.5 });

  for (const e of sky.events) {
    if (e.kind === "ingress" && e.planet === "moon") continue; // already covered by moonHouse
    const lon = e.kind === "lunation" ? allPositions(e.at).moon.lon : allPositions(e.at)[e.planet].lon;
    const w = e.kind === "lunation" ? (e.phase === "new" || e.phase === "full" ? 4 : 2) : e.kind === "ingress" ? 2 : 3.5;
    const h = houseFor(lon);
    facts.push({ kind: "event", event: e, house: h?.house ?? null, basis: h?.basis ?? null, weight: w });
  }

  for (const p of ["mercury", "venus", "mars"] as const) {
    if (sky.retrograde.includes(p)) facts.push({ kind: "retrograde", planet: p, weight: p === "mercury" ? 2 : 1.6 });
  }

  return facts.sort((a, b) => b.weight - a.weight);
}

/** Overall tone from today's aspects: more flowing than tense aspects → "flow". */
export function dayTone(facts: Fact[]): Tone {
  let flow = 0, tension = 0;
  for (const f of facts) {
    if (f.kind !== "aspect") continue;
    const t = ASPECT_TONE[f.aspect];
    if (t === "flow") flow += f.weight;
    if (t === "tension") tension += f.weight;
  }
  if (flow === 0 && tension === 0) return "focus";
  return flow >= tension * 1.2 ? "flow" : tension >= flow * 1.2 ? "tension" : "focus";
}
