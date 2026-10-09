import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/charts.sweph.json";
import { aspectFor, aspectTone, computeMatch, dimensionLabel, MATCH_RULES, PAIRS, validMatchPerson, type Factor, type MatchPerson } from "@/lib/astro/match";
import { longitude } from "@/lib/astro/ephemeris";
import { signOf } from "@/lib/astro/zodiac";

const person = (c: (typeof fixtures.charts)[number], opts: { time?: boolean; place?: boolean } = {}): MatchPerson => ({
  name: c.id,
  date: c.utc.slice(0, 10),
  time: opts.time === false ? null : c.utc.slice(11, 16),
  place: opts.place === false ? null : { name: c.id, country: "", lat: c.lat, lon: c.lon, tz: "UTC" },
});

/** Instants the birth could have happened, sampled densely and independently of the engine. */
function window(p: MatchPerson): Date[] {
  const [y, m, d] = p.date.split("-").map(Number);
  const midnight = Date.UTC(y, m - 1, d);
  if (p.place && p.time) {
    const [hh, mm] = p.time.split(":").map(Number);
    return [new Date(midnight + (hh * 60 + mm) * 60_000)]; // fixtures use tz UTC
  }
  const [start, end] = p.place ? [midnight, midnight + 86_340_000] : [midnight - 14 * 3_600_000, midnight + 36 * 3_600_000 - 60_000];
  return Array.from({ length: 61 }, (_, i) => new Date(start + ((end - start) * i) / 60));
}

const charts = fixtures.charts;
const pairs: [MatchPerson, MatchPerson][] = [
  [person(charts[0]), person(charts[1])],
  [person(charts[2]), person(charts[3], { time: false })],
  [person(charts[4], { time: false }), person(charts[5], { place: false })],
  [person(charts[6], { place: false }), person(charts[7], { time: false })],
  [person(charts[1]), person(charts[4])],
];

describe("match rules", () => {
  it.each(pairs.map((p, i) => [i, ...p] as const))("pair %i: every certain claim holds across both birth windows", (_, a, b) => {
    const r = computeMatch(a, b);
    expect(r.version).toBe(MATCH_RULES.version);
    const wa = window(a), wb = window(b);
    for (const f of r.factors) {
      if (f.a === "asc" || f.b === "asc") continue; // Rising is only used with exact times (checked below)
      const lum = ["sun", "moon"].includes(f.a) || ["sun", "moon"].includes(f.b);
      const la = wa.map((t) => longitude(f.a as never, t)), lb = wb.map((t) => longitude(f.b as never, t));
      if (f.kind === "aspect") {
        for (const x of la) for (const y of lb) expect(aspectFor(x, y, lum)?.aspect, `${f.a}-${f.b}`).toBe(f.aspect);
      }
      if (f.kind === "element") {
        for (const x of la) for (const y of lb) expect(aspectFor(x, y, lum), `${f.a}-${f.b}`).toBeNull();
        expect(new Set(la.map(signOf))).toEqual(new Set([f.signs[0]]));
        expect(new Set(lb.map(signOf))).toEqual(new Set([f.signs[1]]));
      }
      if (f.signs[0]) expect(new Set(la.map(signOf)).size, `${f.a} sign certain`).toBe(1);
      if (f.signs[1]) expect(new Set(lb.map(signOf)).size, `${f.b} sign certain`).toBe(1);
    }
    // labels and score only use usable factors
    const usable = r.factors.filter((f) => f.value !== undefined);
    if (usable.length) {
      expect(r.score).toBeGreaterThanOrEqual(40);
      expect(r.score).toBeLessThanOrEqual(90);
    } else expect(r.score).toBeNull();
    expect(r.factors.every((f) => f.kind !== "uncertain" || f.value === undefined)).toBe(true);
  });

  it("uses Rising only when both people have a time and a place", () => {
    const full = computeMatch(person(charts[0]), person(charts[1]));
    expect(full.factors.some((f) => f.a === "asc" || f.b === "asc")).toBe(true);
    expect(full.notes).toEqual([]);
    for (const [a, b, note] of [
      [person(charts[0]), person(charts[1], { time: false }), "risingB"],
      [person(charts[0], { time: false }), person(charts[1]), "risingA"],
      [person(charts[0]), person(charts[1], { place: false }), "risingB"],
    ] as const) {
      const r = computeMatch(a, b);
      expect(r.factors.some((f) => f.a === "asc" || f.b === "asc")).toBe(false);
      expect(r.notes).toContain(note);
    }
    expect(computeMatch(person(charts[0]), person(charts[1], { place: false })).notes).toContain("windowB");
  });

  it("matching a chart with itself gives exact conjunctions", () => {
    const p = person(charts[2]);
    const r = computeMatch(p, p);
    for (const [a, b] of [["moon", "moon"], ["mercury", "mercury"], ["venus", "venus"], ["sun", "sun"], ["asc", "asc"]]) {
      const f = r.factors.find((x) => x.a === a && x.b === b)!;
      expect(f.kind).toBe("aspect");
      expect(f.aspect).toBe("conjunction");
      expect(f.orb).toBe(0);
    }
  });

  it("a wide window (no birthplace) makes the Moon uncertain instead of guessed", () => {
    const r = computeMatch(person(charts[0]), person(charts[1], { place: false }));
    const moon = r.factors.find((f) => f.a === "moon" && f.b === "moon")!;
    // The Moon moves ~25–30° in the 50-hour window: either both ends agree or it must be uncertain.
    if (moon.kind === "uncertain") expect(moon.options[1].length).toBeGreaterThanOrEqual(1);
    expect(r.factors.filter((f) => f.kind === "uncertain").every((f) => f.tone === undefined)).toBe(true);
  });

  it("labels each dimension by its heaviest tone; ties read as spark; nothing usable is unknown", () => {
    const f = (tone: Factor["tone"], weight: number): Factor => ({ dimension: "emotional", a: "moon", b: "moon", weight, kind: "aspect", tone, signs: [null, null], options: [[], []] });
    expect(dimensionLabel([f("flow", 2), f("edge", 1)])).toBe("flow");
    expect(dimensionLabel([f("edge", 2), f("flow", 1.5)])).toBe("edge");
    expect(dimensionLabel([f("flow", 2), f("edge", 2)])).toBe("spark");
    expect(dimensionLabel([f(undefined, 2)])).toBe("unknown");
    expect(dimensionLabel([])).toBe("unknown");
  });

  it("reads Venus–Mars tension as chemistry, elsewhere as a growth edge", () => {
    expect(aspectTone("attraction", "square")).toBe("spark");
    expect(aspectTone("emotional", "square")).toBe("edge");
    expect(aspectTone("communication", "trine")).toBe("flow");
    expect(aspectTone("core", "conjunction")).toBe("spark");
    // every dimension compares the bodies the plan names
    expect(PAIRS.emotional.every(([a, b]) => [a, b].includes("moon"))).toBe(true);
    expect(PAIRS.communication.every(([a, b]) => [a, b].includes("mercury"))).toBe(true);
    expect(PAIRS.attraction.every(([a, b]) => [a, b].some((x) => x === "venus" || x === "mars"))).toBe(true);
  });

  it("validates the other person's details (date required, time optional)", () => {
    const ok: MatchPerson = { name: "Sam", date: "1998-05-02", time: null, place: null };
    expect(validMatchPerson(ok, "2026-10-09")).toBe(true);
    expect(validMatchPerson({ ...ok, date: "" }, "2026-10-09")).toBe(false);
    expect(validMatchPerson({ ...ok, date: "1998-02-30" }, "2026-10-09")).toBe(false);
    expect(validMatchPerson({ ...ok, date: "2027-01-01" }, "2026-10-09")).toBe(false);
    expect(validMatchPerson({ ...ok, time: "7pm" }, "2026-10-09")).toBe(false);
    expect(validMatchPerson({ ...ok, name: "x".repeat(25) }, "2026-10-09")).toBe(false);
  });
});
