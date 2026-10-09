// Ascendant, Midheaven and house cusps from RAMC, obliquity and latitude.
import { norm360 } from "./zodiac";

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export type HouseSystem = "placidus" | "whole";

export function ascendant(ramcDeg: number, epsDeg: number, latDeg: number): number {
  const t = ramcDeg * RAD, e = epsDeg * RAD, f = latDeg * RAD;
  return norm360(Math.atan2(Math.cos(t), -(Math.sin(t) * Math.cos(e) + Math.tan(f) * Math.sin(e))) * DEG);
}

export function midheaven(ramcDeg: number, epsDeg: number): number {
  const t = ramcDeg * RAD, e = epsDeg * RAD;
  return norm360(Math.atan2(Math.sin(t), Math.cos(t) * Math.cos(e)) * DEG);
}

/** Ecliptic longitude of the ecliptic point with right ascension `ra`. */
function lonFromRa(raDeg: number, epsDeg: number): number {
  const a = raDeg * RAD, e = epsDeg * RAD;
  return norm360(Math.atan2(Math.sin(a), Math.cos(a) * Math.cos(e)) * DEG);
}

/** Placidus fails where some ecliptic degrees never rise (|lat| > 90° − ε ≈ 66.6°). */
export function placidusAvailable(latDeg: number, epsDeg: number): boolean {
  return Math.abs(latDeg) < 90 - epsDeg;
}

/**
 * Placidus cusps by semi-arc trisection, iterated to convergence.
 * Cusp 11/12 sit at 1/3 and 2/3 of the diurnal semi-arc east of the MC;
 * cusp 2/3 at 2/3 and 1/3 of the nocturnal semi-arc west of the IC.
 */
function placidusCusp(ramcDeg: number, epsDeg: number, latDeg: number, house: 11 | 12 | 2 | 3): number {
  const tanLat = Math.tan(latDeg * RAD);
  const sinEps = Math.sin(epsDeg * RAD);
  let ra = ramcDeg + { 11: 30, 12: 60, 2: 120, 3: 150 }[house];
  for (let i = 0; i < 50; i++) {
    const lon = lonFromRa(ra, epsDeg);
    const decl = Math.asin(sinEps * Math.sin(lon * RAD));
    const x = Math.max(-1, Math.min(1, tanLat * Math.tan(decl)));
    const ad = Math.asin(x) * DEG; // ascensional difference
    const dsa = 90 + ad;
    const nsa = 90 - ad;
    const next =
      house === 11 ? ramcDeg + dsa / 3 :
      house === 12 ? ramcDeg + (2 * dsa) / 3 :
      house === 2 ? ramcDeg + 180 - (2 * nsa) / 3 :
      ramcDeg + 180 - nsa / 3;
    if (Math.abs(next - ra) < 1e-7) {
      ra = next;
      break;
    }
    ra = next;
  }
  return lonFromRa(ra, epsDeg);
}

/** Twelve cusp longitudes, index 0 = 1st house. Returns null when the system is undefined at this latitude. */
export function houseCusps(system: HouseSystem, ramcDeg: number, epsDeg: number, latDeg: number): number[] | null {
  const asc = ascendant(ramcDeg, epsDeg, latDeg);
  if (system === "whole") {
    const start = Math.floor(asc / 30) * 30;
    return Array.from({ length: 12 }, (_, i) => norm360(start + i * 30));
  }
  if (!placidusAvailable(latDeg, epsDeg)) return null;
  const mc = midheaven(ramcDeg, epsDeg);
  const c11 = placidusCusp(ramcDeg, epsDeg, latDeg, 11);
  const c12 = placidusCusp(ramcDeg, epsDeg, latDeg, 12);
  const c2 = placidusCusp(ramcDeg, epsDeg, latDeg, 2);
  const c3 = placidusCusp(ramcDeg, epsDeg, latDeg, 3);
  // Houses 1–6; houses 7–12 are their opposites.
  const firstHalf = [asc, c2, c3, norm360(mc + 180), norm360(c11 + 180), norm360(c12 + 180)];
  return [...firstHalf, ...firstHalf.map((c) => norm360(c + 180))];
}

/** Which house (1–12) a longitude falls in, given cusps. */
export function houseOf(lon: number, cusps: number[]): number {
  for (let i = 0; i < 12; i++) {
    const start = cusps[i];
    const end = cusps[(i + 1) % 12];
    const span = norm360(end - start);
    if (norm360(lon - start) < span) return i + 1;
  }
  return 12;
}
