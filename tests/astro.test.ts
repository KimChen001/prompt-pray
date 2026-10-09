import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/charts.sweph.json";
import { allPositions, obliquity, ramc } from "@/lib/astro/ephemeris";
import { ascendant, houseCusps, houseOf, midheaven, placidusAvailable } from "@/lib/astro/houses";
import { placement, PLANETS } from "@/lib/astro/zodiac";

/** Smallest angle between two longitudes. */
const diff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

// Tolerances (degrees). Plan v0.2 requires < 1°; we hold ourselves to much tighter.
const PLANET_TOL = 0.02; // ~1.2′
const ANGLE_TOL = 0.02;
const CUSP_TOL = 0.05;

describe.each(fixtures.charts)("chart $label (vs Swiss Ephemeris)", (c) => {
  const instant = new Date(c.utc);
  const pos = allPositions(instant);
  const r = ramc(instant, c.lon);
  const eps = obliquity(instant);

  it.each(PLANETS)("%s longitude and direction", (p) => {
    const ref = c.planets[p as keyof typeof c.planets];
    expect(diff(pos[p].lon, ref.lon)).toBeLessThan(PLANET_TOL);
    if (Math.abs(ref.speed) > 0.01) expect(Math.sign(pos[p].speed)).toBe(Math.sign(ref.speed));
  });

  it("Ascendant and Midheaven", () => {
    expect(diff(ascendant(r, eps, c.lat), c.asc)).toBeLessThan(ANGLE_TOL);
    expect(diff(midheaven(r, eps), c.mc)).toBeLessThan(ANGLE_TOL);
  });

  it("Placidus cusps", () => {
    const cusps = houseCusps("placidus", r, eps, c.lat)!;
    cusps.forEach((cusp, i) => expect(diff(cusp, c.placidus[i])).toBeLessThan(CUSP_TOL));
  });

  it("Whole Sign cusps", () => {
    const cusps = houseCusps("whole", r, eps, c.lat)!;
    cusps.forEach((cusp, i) => expect(diff(cusp, c.wholeSign[i])).toBeLessThan(1e-6));
  });
});

describe("houses helpers", () => {
  it("assigns houses across the 360° wrap", () => {
    const cusps = [350, 20, 50, 80, 110, 140, 170, 200, 230, 260, 290, 320];
    expect(houseOf(355, cusps)).toBe(1);
    expect(houseOf(5, cusps)).toBe(1);
    expect(houseOf(20, cusps)).toBe(2);
    expect(houseOf(345, cusps)).toBe(12);
  });
  it("refuses Placidus above the polar circle", () => {
    expect(placidusAvailable(64.1, 23.44)).toBe(true);
    expect(placidusAvailable(69.6, 23.44)).toBe(false);
    expect(houseCusps("placidus", 100, 23.44, 69.6)).toBeNull();
    expect(houseCusps("whole", 100, 23.44, 69.6)).toHaveLength(12);
  });
  it("formats placements", () => {
    expect(placement(141.2482)).toMatchObject({ sign: "leo", degree: 21, minute: 14 });
    expect(placement(359.999)).toMatchObject({ sign: "pisces", degree: 29, minute: 59 });
    expect(placement(-1)).toMatchObject({ sign: "pisces", degree: 29 });
  });
});
