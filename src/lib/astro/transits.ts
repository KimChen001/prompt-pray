// Transits for the daily horoscope (plan v0.2 §3.3): how today's real sky relates to a person.
// Two modes:
//  - natal: the user has a birth chart → degree-based aspects to natal Sun/Moon/Ascendant, natal houses.
//  - sign:  only a Sun sign → sign-based aspects and solar houses (the Sun sign is the 1st house).
import { allPositions } from "./ephemeris";
import { houseOf } from "./houses";
import { SIGNS, norm360, signOf, type Planet, type Sign } from "./zodiac";
import type { NatalChart } from "./chart";
import type { DaySky } from "./sky";

export type Aspect = "conjunction" | "sextile" | "square" | "trine" | "opposition";
export type Tone = "flow" | "tension" | "focus";
export const ASPECT_TONE: Record<Aspect, Tone> = { conjunction: "focus", sextile: "flow", trine: "flow", square: "tension", opposition: "tension" };
const ASPECT_ANGLE: Record<Aspect, number> = { conjunction: 0, sextile: 60, square: 90, trine: 120, opposition: 180 };

export const TRANSITING: Planet[] = ["sun", "moon", "mercury", "venus", "mars"];
export type NatalPoint = "sun" | "moon" | "asc";
const ORB: Record<Planet, number> = { sun: 3, moon: 6, mercury: 3, venus: 3, mars: 3, jupiter: 2, saturn: 2, uranus: 2, neptune: 2, pluto: 2 };

export type Fact =
  | { kind: "aspect"; transit: Planet; aspect: Aspect; natal: NatalPoint; orb: number; weight: number }
  | { kind: "moonHouse"; house: number; sign: Sign; weight: number }
  | { kind: "event"; event: DaySky["events"][number]; house: number | null; weight: number }
  | { kind: "retrograde"; planet: "mercury" | "venus" | "mars"; weight: number };

export interface Subject {
  mode: "natal" | "sign";
  sunSign: Sign;
  natal?: Pick<NatalChart, "positions" | "asc" | "cusps">;
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
  const houseFor = (lon: number) =>
    subject.mode === "natal" && subject.natal?.cusps ? houseOf(lon, subject.natal.cusps) : solarHouse(signOf(lon), subject.sunSign);

  if (subject.mode === "natal" && subject.natal) {
    const points: [NatalPoint, number | undefined][] = [
      ["sun", subject.natal.positions.sun.lon],
      ["moon", subject.natal.positions.moon.lon],
      ["asc", subject.natal.asc?.lon],
    ];
    for (const t of TRANSITING) {
      for (const [p, lon] of points) {
        if (lon === undefined) continue;
        const hit = aspectBetween(now[t].lon, lon, ORB[t]);
        if (hit) facts.push({ kind: "aspect", transit: t, natal: p, aspect: hit.aspect, orb: hit.orb, weight: TRANSIT_WEIGHT[t] * POINT_WEIGHT[p] * (1 - hit.orb / (ORB[t] + 1)) });
      }
    }
  } else {
    for (const t of TRANSITING) {
      if (t === "sun") continue; // the Sun is in its own sign once a year; skip the trivial self-aspect
      const a = signAspect(subject.sunSign, signOf(now[t].lon));
      if (a) facts.push({ kind: "aspect", transit: t, natal: "sun", aspect: a, orb: 0, weight: TRANSIT_WEIGHT[t] * 0.8 });
    }
  }

  facts.push({ kind: "moonHouse", house: houseFor(sky.moon.placement.lon), sign: sky.moon.placement.sign, weight: 1.5 });

  for (const e of sky.events) {
    if (e.kind === "ingress" && e.planet === "moon") continue; // already covered by moonHouse
    const lon = e.kind === "lunation" ? allPositions(e.at).moon.lon : allPositions(e.at)[e.planet].lon;
    const w = e.kind === "lunation" ? (e.phase === "new" || e.phase === "full" ? 4 : 2) : e.kind === "ingress" ? 2 : 3.5;
    facts.push({ kind: "event", event: e, house: houseFor(lon), weight: w });
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
