// Real positions from astronomy-engine (MIT). Verified against Swiss Ephemeris fixtures in
// tests/fixtures/charts.sweph.json — see tests/astro.test.ts for tolerances.
import * as A from "astronomy-engine";
import { norm360, PLANETS, type Planet } from "./zodiac";

const BODY: Record<Exclude<Planet, "sun" | "moon">, A.Body> = {
  mercury: A.Body.Mercury,
  venus: A.Body.Venus,
  mars: A.Body.Mars,
  jupiter: A.Body.Jupiter,
  saturn: A.Body.Saturn,
  uranus: A.Body.Uranus,
  neptune: A.Body.Neptune,
  pluto: A.Body.Pluto,
};

/** Apparent geocentric ecliptic longitude (true equinox of date), degrees. */
export function longitude(planet: Planet, instant: Date): number {
  const t = A.MakeTime(instant);
  if (planet === "sun") return norm360(A.SunPosition(t).elon);
  if (planet === "moon") return norm360(A.EclipticGeoMoon(t).lon);
  return norm360(A.Ecliptic(A.GeoVector(BODY[planet], t, true)).elon);
}

/** Daily motion in degrees/day; negative means retrograde. */
export function speed(planet: Planet, instant: Date): number {
  const ms = instant.getTime();
  const a = longitude(planet, new Date(ms - 6 * 3600e3));
  const b = longitude(planet, new Date(ms + 6 * 3600e3));
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d * 2;
}

export interface BodyPosition {
  lon: number;
  speed: number;
  retrograde: boolean;
}

export function allPositions(instant: Date): Record<Planet, BodyPosition> {
  return Object.fromEntries(
    PLANETS.map((p) => {
      const s = speed(p, instant);
      return [p, { lon: longitude(p, instant), speed: s, retrograde: s < 0 && p !== "sun" && p !== "moon" }];
    }),
  ) as Record<Planet, BodyPosition>;
}

/** True obliquity of the ecliptic, degrees. */
export function obliquity(instant: Date): number {
  return A.e_tilt(A.MakeTime(instant)).tobl;
}

/** Local apparent sidereal time as an angle (RAMC), degrees. East longitude positive. */
export function ramc(instant: Date, longitudeEast: number): number {
  return norm360(A.SiderealTime(A.MakeTime(instant)) * 15 + longitudeEast);
}

// ---------- Moon phase, used by Today's sky ----------
export function moonPhase(instant: Date): { angle: number; illumination: number } {
  const t = A.MakeTime(instant);
  return { angle: A.MoonPhase(t), illumination: A.Illumination(A.Body.Moon, t).phase_fraction };
}
