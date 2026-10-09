// Match (plan v0.2 §3.5), same-device version: two people's charts compared with fixed, versioned
// rules. Every conclusion is a factor with its basis (bodies, aspect or elements). When a birth time
// or place is missing, each body is sampled across every moment the birth could have happened; a
// sign or aspect is used only if it holds for the whole window, otherwise the factor is "uncertain"
// and is left out of the labels and the score. Rising is used only when both times and places are known.
// The score is for fun: a weighted average of traditional factor values, never a success probability.
import { ascendant } from "./houses";
import { longitude, obliquity, ramc } from "./ephemeris";
import { birthInstant, resolveLocal, type BirthPlace } from "./birth";
import { NATAL_RULES } from "./natal-facts";
import { SIGN_INFO, signOf, type Planet, type Sign } from "./zodiac";
import type { Aspect } from "./transits";
import type { Element } from "@/lib/tarot/types";
import { addDays } from "@/lib/memory";

export const MATCH_RULES = {
  version: "match-rules@1",
  /** Same orbs as birth charts; +luminaryBonus when the Sun or Moon is involved. */
  orbs: NATAL_RULES.orbs,
  luminaryBonus: NATAL_RULES.luminaryBonus,
  /** Points spread over the possible birth window when the exact moment is unknown. */
  samples: 9,
  /** Traditional "how easy" value of each relation, used only for the for-fun score. */
  aspectValue: { trine: 90, sextile: 80, conjunction: 85, opposition: 55, square: 45 } as Record<Aspect, number>,
  elementValue: { same: 75, compatible: 70, other: 50 },
} as const;

export type MatchBody = Extract<Planet, "sun" | "moon" | "mercury" | "venus" | "mars"> | "asc";
export type Dimension = "emotional" | "communication" | "attraction" | "core";
export type Tone = "flow" | "spark" | "edge";
export type DimensionLabel = Tone | "unknown";

/** Pairs compared, by dimension: [person A body, person B body, weight]. */
export const PAIRS: Record<Dimension, [MatchBody, MatchBody, number][]> = {
  emotional: [["moon", "moon", 2], ["sun", "moon", 1.5], ["moon", "sun", 1.5]],
  communication: [["mercury", "mercury", 2], ["mercury", "sun", 1], ["sun", "mercury", 1]],
  attraction: [["venus", "mars", 2], ["mars", "venus", 2], ["venus", "venus", 1]],
  core: [["sun", "sun", 2], ["asc", "asc", 1], ["sun", "asc", 1], ["asc", "sun", 1]],
};

export interface MatchPerson {
  name: string;
  date: string; // YYYY-MM-DD
  time: string | null;
  place: BirthPlace | null;
  offsetChoice?: number;
}

interface BodySpan {
  samples: number[]; // ecliptic longitudes across the possible birth window
  sign: Sign | null; // null when the sign changes within the window
  options: Sign[]; // every sign the body could be in
}

export interface Factor {
  dimension: Dimension;
  a: MatchBody;
  b: MatchBody;
  weight: number;
  kind: "aspect" | "element" | "uncertain" | "unavailable";
  aspect?: Aspect;
  orb?: number;
  relation?: "same" | "compatible" | "other";
  signs: [Sign | null, Sign | null];
  options: [Sign[], Sign[]];
  tone?: Tone;
  value?: number;
}

export interface MatchResult {
  version: string;
  score: number | null;
  labels: Record<Exclude<Dimension, "core">, DimensionLabel>;
  factors: Factor[];
  /** Why parts were left out: "risingA" / "risingB" (no time or place), "windowA" / "windowB" (place unknown). */
  notes: string[];
}

const MINUTE = 60_000;

/** Every instant the birth could have been, as evenly spaced samples. */
function birthWindow(p: MatchPerson): Date[] {
  if (p.place && p.time) {
    const r = birthInstant({ date: p.date, time: p.time, place: p.place, offsetChoice: p.offsetChoice });
    if (r) return [r.utc];
  }
  let start: number, end: number;
  if (p.place) {
    const at = (t: string) => {
      const r = resolveLocal(p.date, t, p.place!.tz);
      return (r.status === "ok" ? r.result.utc : r.status === "ambiguous" ? r.options[0].utc : r.suggestion.utc).getTime();
    };
    start = at("00:00");
    end = at("23:59");
  } else {
    // Unknown place: the local date could start as early as UTC+14 and end as late as UTC−12.
    const [y, m, d] = p.date.split("-").map(Number);
    const midnightUtc = Date.UTC(y, m - 1, d);
    start = midnightUtc - 14 * 60 * MINUTE;
    end = midnightUtc + 24 * 60 * MINUTE + 12 * 60 * MINUTE - MINUTE;
  }
  const n = MATCH_RULES.samples;
  return Array.from({ length: n }, (_, i) => new Date(start + ((end - start) * i) / (n - 1)));
}

function spans(p: MatchPerson): Record<MatchBody, BodySpan | null> {
  const when = birthWindow(p);
  const exact = when.length === 1 && !!p.place && !!p.time;
  const span = (lons: number[]): BodySpan => {
    const options = [...new Set(lons.map(signOf))];
    return { samples: lons, sign: options.length === 1 ? options[0] : null, options };
  };
  const out = {} as Record<MatchBody, BodySpan | null>;
  for (const body of ["sun", "moon", "mercury", "venus", "mars"] as const) out[body] = span(when.map((t) => longitude(body, t)));
  out.asc = exact ? span([ascendant(ramc(when[0], p.place!.lon), obliquity(when[0]), p.place!.lat)]) : null;
  return out;
}

const SEP = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
};
const ANGLE: Record<Aspect, number> = { conjunction: 0, sextile: 60, square: 90, trine: 120, opposition: 180 };
const isLuminary = (b: MatchBody) => b === "sun" || b === "moon";

/** The aspect (with its own orb) between two longitudes, or null. */
export function aspectFor(x: number, y: number, luminary: boolean): { aspect: Aspect; orb: number } | null {
  const sep = SEP(x, y);
  for (const aspect of Object.keys(ANGLE) as Aspect[]) {
    const orb = Math.abs(sep - ANGLE[aspect]);
    if (orb <= MATCH_RULES.orbs[aspect] + (luminary ? MATCH_RULES.luminaryBonus : 0)) return { aspect, orb: +orb.toFixed(2) };
  }
  return null;
}

const COMPATIBLE: Record<Element, Element> = { fire: "air", air: "fire", earth: "water", water: "earth" };
function elementRelation(a: Sign, b: Sign): "same" | "compatible" | "other" {
  const ea = SIGN_INFO[a].element, eb = SIGN_INFO[b].element;
  return ea === eb ? "same" : COMPATIBLE[ea] === eb ? "compatible" : "other";
}

export function aspectTone(dimension: Dimension, aspect: Aspect): Tone {
  if (aspect === "trine" || aspect === "sextile") return "flow";
  if (aspect === "conjunction") return "spark";
  // In attraction, tension between Venus and Mars is traditionally read as chemistry.
  return dimension === "attraction" ? "spark" : "edge";
}

function compare(dimension: Dimension, a: MatchBody, b: MatchBody, weight: number, sa: BodySpan | null, sb: BodySpan | null): Factor {
  const base = { dimension, a, b, weight, signs: [sa?.sign ?? null, sb?.sign ?? null] as [Sign | null, Sign | null], options: [sa?.options ?? [], sb?.options ?? []] as [Sign[], Sign[]] };
  if (!sa || !sb) return { ...base, kind: "unavailable" };
  const lum = isLuminary(a) || isLuminary(b);
  const hits = sa.samples.flatMap((x) => sb.samples.map((y) => aspectFor(x, y, lum)));
  const first = hits[0];
  if (first && hits.every((h) => h?.aspect === first.aspect)) {
    const orb = Math.max(...hits.map((h) => h!.orb));
    return { ...base, kind: "aspect", aspect: first.aspect, orb, tone: aspectTone(dimension, first.aspect), value: MATCH_RULES.aspectValue[first.aspect] };
  }
  if (hits.every((h) => h === null) && sa.sign && sb.sign) {
    const relation = elementRelation(sa.sign, sb.sign);
    return { ...base, kind: "element", relation, tone: relation === "other" ? "edge" : "flow", value: MATCH_RULES.elementValue[relation] };
  }
  return { ...base, kind: "uncertain" };
}

/** The tone with the most weight among a dimension's usable factors (ties read as "spark"). */
export function dimensionLabel(factors: Factor[]): DimensionLabel {
  const usable = factors.filter((f) => f.tone);
  if (!usable.length) return "unknown";
  const w = { flow: 0, spark: 0, edge: 0 };
  for (const f of usable) w[f.tone!] += f.weight;
  if (w.flow > w.spark && w.flow > w.edge) return "flow";
  if (w.edge > w.spark && w.edge > w.flow) return "edge";
  return "spark";
}

export function computeMatch(pa: MatchPerson, pb: MatchPerson): MatchResult {
  const A = spans(pa), B = spans(pb);
  const risingBoth = !!A.asc && !!B.asc; // plan: Rising relations only when both birth times are known
  const factors: Factor[] = [];
  for (const [dimension, pairs] of Object.entries(PAIRS) as [Dimension, [MatchBody, MatchBody, number][]][]) {
    for (const [a, b, w] of pairs) {
      if ((a === "asc" || b === "asc") && !risingBoth) continue;
      const f = compare(dimension, a, b, w, A[a], B[b]);
      if (f.kind !== "unavailable") factors.push(f);
    }
  }
  const usable = factors.filter((f) => f.value !== undefined);
  const total = usable.reduce((s, f) => s + f.weight, 0);
  const score = total ? Math.round(usable.reduce((s, f) => s + f.value! * f.weight, 0) / total) : null;
  const notes: string[] = [];
  if (!A.asc) notes.push("risingA");
  if (!B.asc) notes.push("risingB");
  if (!pa.place) notes.push("windowA");
  if (!pb.place) notes.push("windowB");
  const by = (d: Dimension) => factors.filter((f) => f.dimension === d);
  return {
    version: MATCH_RULES.version,
    score,
    labels: { emotional: dimensionLabel(by("emotional")), communication: dimensionLabel(by("communication")), attraction: dimensionLabel(by("attraction")) },
    factors,
    notes,
  };
}

/** A birth date is required; a time is used only with a place (the time zone comes from the place). */
export function validMatchPerson(p: MatchPerson, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date) || addDays(p.date, 0) !== p.date || p.date < "1900-01-01" || p.date > today) return false;
  if (p.time !== null && !/^\d{2}:\d{2}$/.test(p.time)) return false;
  return p.name.length <= 24;
}
