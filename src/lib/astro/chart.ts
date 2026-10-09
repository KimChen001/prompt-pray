// Natal chart + Big Three, including the unknown-birth-time rules from plan v0.2 §3.1:
// never guess a Rising sign; show both candidates when the Sun or Moon changes sign that day.
import { allPositions, longitude, obliquity, ramc, type BodyPosition } from "./ephemeris";
import { ascendant, houseCusps, houseOf, midheaven, placidusAvailable, type HouseSystem } from "./houses";
import { birthInstant, localTimeIn, resolveLocal, type BirthData, type ResolvedTime } from "./birth";
import { placement, signOf, type Placement, type Planet, type Sign } from "./zodiac";

export interface SignCandidate {
  /** Certain placement (time known, or the sign does not change that day). */
  placement: Placement | null;
  /** When the time is unknown and the body changes sign that day: both signs, in order. */
  options: Sign[] | null;
  /** Local time ("HH:MM") the body enters the second sign. */
  changesAt: string | null;
}

export interface NatalChart {
  timeKnown: boolean;
  resolved: ResolvedTime | null;
  positions: Record<Planet, BodyPosition & { placement: Placement; house: number | null }>;
  asc: Placement | null;
  mc: Placement | null;
  houseSystem: HouseSystem | null;
  houseFallback: boolean; // Placidus requested but unavailable at this latitude
  cusps: number[] | null;
  bigThree: { sun: SignCandidate; moon: SignCandidate; rising: SignCandidate | null };
}

/** First and last minute of the birth date in the birthplace's time zone. */
export function birthDayRange(b: BirthData): { start: Date; end: Date } {
  return { start: instantForLocal(b, "00:00"), end: instantForLocal(b, "23:59") };
}

function instantForLocal(b: BirthData, time: string): Date {
  const r = resolveLocal(b.date, time, b.place.tz);
  return r.status === "ok" ? r.result.utc : r.status === "ambiguous" ? r.options[0].utc : r.suggestion.utc;
}

/** Sign of a body across the whole local day; finds the change time by bisection. */
function daySign(planet: "sun" | "moon", b: BirthData): SignCandidate {
  const start = instantForLocal(b, "00:00");
  const end = instantForLocal(b, "23:59");
  const s0 = signOf(longitude(planet, start));
  const s1 = signOf(longitude(planet, end));
  if (s0 === s1) {
    const noon = instantForLocal(b, "12:00");
    return { placement: placement(longitude(planet, noon)), options: null, changesAt: null };
  }
  let lo = start.getTime();
  let hi = end.getTime();
  while (hi - lo > 30e3) {
    const mid = (lo + hi) / 2;
    if (signOf(longitude(planet, new Date(mid))) === s0) lo = mid;
    else hi = mid;
  }
  return { placement: null, options: [s0, s1], changesAt: localTimeIn(hi, b.place.tz) };
}

export function computeChart(b: BirthData, system: HouseSystem = "placidus"): NatalChart {
  const resolved = birthInstant(b);
  const timeKnown = !!resolved;
  const instant = resolved?.utc ?? instantForLocal(b, "12:00");
  const pos = allPositions(instant);

  let asc: Placement | null = null;
  let mc: Placement | null = null;
  let cusps: number[] | null = null;
  let houseSystem: HouseSystem | null = null;
  let houseFallback = false;
  if (timeKnown) {
    const r = ramc(instant, b.place.lon);
    const eps = obliquity(instant);
    asc = placement(ascendant(r, eps, b.place.lat));
    mc = placement(midheaven(r, eps));
    houseSystem = system === "placidus" && !placidusAvailable(b.place.lat, eps) ? "whole" : system;
    houseFallback = houseSystem !== system;
    cusps = houseCusps(houseSystem, r, eps, b.place.lat);
  }

  const positions = Object.fromEntries(
    (Object.keys(pos) as Planet[]).map((p) => [p, { ...pos[p], placement: placement(pos[p].lon), house: cusps ? houseOf(pos[p].lon, cusps) : null }]),
  ) as NatalChart["positions"];

  const certain = (pl: Placement): SignCandidate => ({ placement: pl, options: null, changesAt: null });
  const bigThree = timeKnown
    ? { sun: certain(positions.sun.placement), moon: certain(positions.moon.placement), rising: certain(asc!) }
    : { sun: daySign("sun", b), moon: daySign("moon", b), rising: null };

  return { timeKnown, resolved, positions, asc, mc, houseSystem, houseFallback, cusps, bigThree };
}
