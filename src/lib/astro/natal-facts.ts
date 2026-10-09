// Natal fact layer (combined review, "事实层"): every aspect, placement, angular planet, ruler,
// stellium and element/modality balance is computed here — the model never computes or adds any.
// Each fact has a stable id, typed values and an applicability condition (needs a birth time?).
// All thresholds live in NATAL_RULES; bump `version` whenever any of them changes.
import { birthDayRange, type NatalChart } from "./chart";
import { longitude } from "./ephemeris";
import type { BirthData } from "./birth";
import { PLANETS, SIGN_INFO, signOf, type Modality, type Planet, type Sign } from "./zodiac";
import { aspectBetween, type Aspect } from "./transits";
import type { Element } from "@/lib/tarot/types";

export const NATAL_RULES = {
  version: "natal-facts@1",
  /** Base orbs (degrees) by aspect; widened when the Sun or Moon is involved. */
  orbs: { conjunction: 8, opposition: 8, square: 6, trine: 6, sextile: 4 } as Record<Aspect, number>,
  luminaryBonus: 2,
  /** An aspect at or under this orb is "tight". */
  tightOrb: 3,
  /** Planets counted for stelliums and element/modality balance (outer planets are generational). */
  personal: ["sun", "moon", "mercury", "venus", "mars"] as Planet[],
  social: ["jupiter", "saturn"] as Planet[],
  generational: ["uranus", "neptune", "pluto"] as Planet[],
  stelliumMin: 3,
  angularHouses: [1, 4, 7, 10] as number[],
  /** A planet within this many degrees of the Ascendant or Midheaven counts as on the angle. */
  angleOrb: 5,
  /** Element/modality weights. The Ascendant counts only with a known birth time. */
  balanceWeights: { sun: 3, moon: 3, asc: 3, mercury: 2, venus: 2, mars: 2, jupiter: 1, saturn: 1 } as Record<string, number>,
  dominantShare: 0.4,
  /** Modern rulerships (common in US astrology). */
  rulers: {
    aries: "mars", taurus: "venus", gemini: "mercury", cancer: "moon", leo: "sun", virgo: "mercury",
    libra: "venus", scorpio: "pluto", sagittarius: "jupiter", capricorn: "saturn", aquarius: "uranus", pisces: "neptune",
  } as Record<Sign, Planet>,
} as const;

export type Body = Planet | "asc" | "mc";

interface FactBase {
  id: string;
  /** False when the fact is only valid with a known birth time. */
  timeIndependent: boolean;
}

export type NatalFact =
  | (FactBase & { kind: "placement"; body: Planet; sign: Sign; degree: number; approximate: boolean; house: number | null; retrograde: boolean })
  | (FactBase & { kind: "uncertainPlacement"; body: "sun" | "moon"; options: [Sign, Sign]; changesAt: string })
  | (FactBase & { kind: "angle"; body: "asc" | "mc"; sign: Sign; degree: number })
  | (FactBase & { kind: "aspect"; a: Planet; b: Planet; aspect: Aspect; orb: number; tight: boolean })
  | (FactBase & { kind: "angular"; body: Planet; house: number; onAngle: "asc" | "mc" | "dsc" | "ic" | null })
  | (FactBase & { kind: "chartRuler"; ruler: Planet; ascSign: Sign; rulerSign: Sign; rulerHouse: number })
  | (FactBase & { kind: "stellium"; scope: "sign"; sign: Sign; bodies: Planet[] })
  | (FactBase & { kind: "stellium"; scope: "house"; house: number; bodies: Planet[] })
  | (FactBase & { kind: "balance"; dimension: "element"; value: Element; state: "dominant" | "absent"; share: number })
  | (FactBase & { kind: "balance"; dimension: "modality"; value: Modality; state: "dominant" | "absent"; share: number });

export interface NatalFacts {
  version: string;
  timeKnown: boolean;
  facts: NatalFact[];
  byId: Map<string, NatalFact>;
}

const ELEMENTS: Element[] = ["fire", "earth", "air", "water"];
const MODALITIES: Modality[] = ["cardinal", "fixed", "mutable"];

function orbFor(aspect: Aspect, a: Planet, b: Planet): number {
  const lum = a === "sun" || a === "moon" || b === "sun" || b === "moon";
  return NATAL_RULES.orbs[aspect] + (lum ? NATAL_RULES.luminaryBonus : 0);
}

/**
 * Builds the fact list for a chart. With an unknown birth time: no Ascendant, Midheaven, houses,
 * angular planets or chart ruler; a Sun/Moon that changes sign that day becomes `uncertainPlacement`;
 * Moon aspects are kept only if they hold for the entire birth day.
 */
export function natalFacts(birth: BirthData, chart: NatalChart): NatalFacts {
  const facts: NatalFact[] = [];
  const known = chart.timeKnown;
  const uncertain = new Set<Planet>();

  for (const lum of ["sun", "moon"] as const) {
    const c = chart.bigThree[lum];
    if (!known && c.options) {
      uncertain.add(lum);
      facts.push({ id: `place.${lum}`, kind: "uncertainPlacement", timeIndependent: true, body: lum, options: [c.options[0], c.options[1]], changesAt: c.changesAt! });
    }
  }
  for (const p of PLANETS) {
    if (uncertain.has(p)) continue;
    const pos = chart.positions[p];
    facts.push({
      // Without a birth time the degree is the local-noon value (the Moon can be ~7° off); the sign is certain.
      id: `place.${p}`, kind: "placement", timeIndependent: pos.house === null, body: p,
      sign: pos.placement.sign, degree: pos.placement.degree, approximate: !known, house: pos.house, retrograde: pos.retrograde,
    });
  }
  if (known && chart.asc && chart.mc) {
    facts.push({ id: "angle.asc", kind: "angle", timeIndependent: false, body: "asc", sign: chart.asc.sign, degree: chart.asc.degree });
    facts.push({ id: "angle.mc", kind: "angle", timeIndependent: false, body: "mc", sign: chart.mc.sign, degree: chart.mc.degree });
  }

  // Aspects between planets. Without a birth time the Moon is checked at both ends of the day.
  const day = known ? null : birthDayRange(birth);
  const moonEnds = day ? [longitude("moon", day.start), longitude("moon", day.end)] : null;
  for (let i = 0; i < PLANETS.length; i++) {
    for (let j = i + 1; j < PLANETS.length; j++) {
      const a = PLANETS[i], b = PLANETS[j];
      if (NATAL_RULES.generational.includes(a) && NATAL_RULES.generational.includes(b)) continue; // generation-wide, not personal
      const maxOrb = Math.max(...Object.values(NATAL_RULES.orbs)) + NATAL_RULES.luminaryBonus;
      const hit = aspectBetween(chart.positions[a].lon, chart.positions[b].lon, maxOrb);
      if (!hit || hit.orb > orbFor(hit.aspect, a, b)) continue;
      if (moonEnds && (a === "moon" || b === "moon")) {
        const other = a === "moon" ? chart.positions[b].lon : chart.positions[a].lon;
        const holds = moonEnds.every((m) => aspectBetween(m, other, orbFor(hit.aspect, a, b))?.aspect === hit.aspect);
        if (!holds) continue;
      }
      facts.push({ id: `asp.${a}.${b}.${hit.aspect}`, kind: "aspect", timeIndependent: true, a, b, aspect: hit.aspect, orb: hit.orb, tight: hit.orb <= NATAL_RULES.tightOrb });
    }
  }

  if (known && chart.asc && chart.mc) {
    const angles = { asc: chart.asc.lon, mc: chart.mc.lon, dsc: (chart.asc.lon + 180) % 360, ic: (chart.mc.lon + 180) % 360 };
    for (const p of PLANETS) {
      const pos = chart.positions[p];
      const onAngle = (Object.entries(angles) as ["asc" | "mc" | "dsc" | "ic", number][]).find(([, lon]) => aspectBetween(pos.lon, lon, NATAL_RULES.angleOrb)?.aspect === "conjunction")?.[0] ?? null;
      if (pos.house !== null && (NATAL_RULES.angularHouses.includes(pos.house) || onAngle)) {
        facts.push({ id: `angular.${p}`, kind: "angular", timeIndependent: false, body: p, house: pos.house, onAngle });
      }
    }
    const ruler = NATAL_RULES.rulers[chart.asc.sign];
    const rp = chart.positions[ruler];
    facts.push({ id: "ruler.asc", kind: "chartRuler", timeIndependent: false, ruler, ascSign: chart.asc.sign, rulerSign: rp.placement.sign, rulerHouse: rp.house! });
  }

  // Stelliums: 3+ personal/social planets in one sign (any time) or one house (time known).
  const counted = [...NATAL_RULES.personal, ...NATAL_RULES.social].filter((p) => !uncertain.has(p));
  const bySign = new Map<Sign, Planet[]>();
  const byHouse = new Map<number, Planet[]>();
  for (const p of counted) {
    const s = chart.positions[p].placement.sign;
    bySign.set(s, [...(bySign.get(s) ?? []), p]);
    const h = chart.positions[p].house;
    if (h !== null) byHouse.set(h, [...(byHouse.get(h) ?? []), p]);
  }
  for (const [sign, bodies] of bySign) if (bodies.length >= NATAL_RULES.stelliumMin) facts.push({ id: `stellium.sign.${sign}`, kind: "stellium", scope: "sign", timeIndependent: true, sign, bodies });
  for (const [house, bodies] of byHouse) if (bodies.length >= NATAL_RULES.stelliumMin) facts.push({ id: `stellium.house.${house}`, kind: "stellium", scope: "house", timeIndependent: false, house, bodies });

  // Element and modality balance.
  const weights = NATAL_RULES.balanceWeights;
  const contributions: [Sign, number][] = counted.map((p) => [chart.positions[p].placement.sign, weights[p] ?? 0]);
  if (known && chart.asc) contributions.push([chart.asc.sign, weights.asc]);
  const total = contributions.reduce((s, [, w]) => s + w, 0);
  const tally = <T extends string>(values: T[], pick: (s: Sign) => T) => {
    const sums = Object.fromEntries(values.map((v) => [v, 0])) as Record<T, number>;
    for (const [s, w] of contributions) sums[pick(s)] += w;
    return sums;
  };
  const el = tally(ELEMENTS, (s) => SIGN_INFO[s].element);
  const mo = tally(MODALITIES, (s) => SIGN_INFO[s].modality);
  for (const e of ELEMENTS) {
    const share = +(el[e] / total).toFixed(3);
    if (share >= NATAL_RULES.dominantShare) facts.push({ id: `balance.element.${e}.dominant`, kind: "balance", dimension: "element", value: e, state: "dominant", share, timeIndependent: !known });
    if (share === 0) facts.push({ id: `balance.element.${e}.absent`, kind: "balance", dimension: "element", value: e, state: "absent", share, timeIndependent: !known });
  }
  for (const q of MODALITIES) {
    const share = +(mo[q] / total).toFixed(3);
    if (share >= NATAL_RULES.dominantShare + 0.1) facts.push({ id: `balance.modality.${q}.dominant`, kind: "balance", dimension: "modality", value: q, state: "dominant", share, timeIndependent: !known });
    if (share === 0) facts.push({ id: `balance.modality.${q}.absent`, kind: "balance", dimension: "modality", value: q, state: "absent", share, timeIndependent: !known });
  }

  facts.sort((x, y) => x.id.localeCompare(y.id));
  return { version: NATAL_RULES.version, timeKnown: known, facts, byId: new Map(facts.map((f) => [f.id, f])) };
}

export function factBodies(f: NatalFact): Body[] {
  switch (f.kind) {
    case "placement":
    case "uncertainPlacement":
    case "angle":
    case "angular":
      return [f.body];
    case "aspect":
      return [f.a, f.b];
    case "chartRuler":
      return ["asc", f.ruler];
    case "stellium":
      return f.bodies;
    case "balance":
      return [];
  }
}

