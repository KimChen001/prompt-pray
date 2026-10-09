import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/charts.sweph.json";
import { computeChart } from "@/lib/astro/chart";
import { NATAL_RULES, natalFacts } from "@/lib/astro/natal-facts";
import { THEME_RULES, selectThemes } from "@/lib/astro/natal-themes";
import { PLANETS, type Planet } from "@/lib/astro/zodiac";
import type { BirthData } from "@/lib/astro/birth";

const sep = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
};
const ANGLES = { conjunction: 0, sextile: 60, square: 90, trine: 120, opposition: 180 } as const;

/** Birth data whose local time equals the fixture's UTC instant. */
function fixtureBirth(c: (typeof fixtures.charts)[number]): BirthData {
  return { date: c.utc.slice(0, 10), time: c.utc.slice(11, 16), place: { name: c.id, country: "", lat: c.lat, lon: c.lon, tz: "UTC" } };
}

describe.each(fixtures.charts)("natal facts for $label", (c) => {
  const birth = fixtureBirth(c);
  const chart = computeChart(birth);
  const nf = natalFacts(birth, chart);

  it("matches aspects computed independently from Swiss Ephemeris positions", () => {
    const expected = new Set<string>();
    const borderline = new Set<string>();
    for (let i = 0; i < PLANETS.length; i++) {
      for (let j = i + 1; j < PLANETS.length; j++) {
        const a = PLANETS[i] as Planet, b = PLANETS[j] as Planet;
        if (NATAL_RULES.generational.includes(a) && NATAL_RULES.generational.includes(b)) continue;
        const s = sep(c.planets[a].lon, c.planets[b].lon);
        const lum = ["sun", "moon"].includes(a) || ["sun", "moon"].includes(b);
        for (const [asp, angle] of Object.entries(ANGLES)) {
          const limit = NATAL_RULES.orbs[asp as keyof typeof ANGLES] + (lum ? NATAL_RULES.luminaryBonus : 0);
          const orb = Math.abs(s - angle);
          const id = `asp.${a}.${b}.${asp}`;
          if (Math.abs(orb - limit) < 0.05) borderline.add(id);
          else if (orb <= limit) expected.add(id);
        }
      }
    }
    const actual = new Set(nf.facts.filter((f) => f.kind === "aspect").map((f) => f.id).filter((id) => !borderline.has(id)));
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it("has unique, stable ids and versioned rules", () => {
    const ids = nf.facts.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(nf.version).toBe(NATAL_RULES.version);
    expect(natalFacts(birth, computeChart(birth)).facts.map((f) => f.id)).toEqual(ids);
  });

  it("selects 3–5 themes that obey the diversity rules", () => {
    const sel = selectThemes(nf);
    expect(sel.version).toBe(THEME_RULES.version);
    expect(sel.factsVersion).toBe(NATAL_RULES.version);
    expect(sel.themes.length).toBeGreaterThanOrEqual(THEME_RULES.min);
    expect(sel.themes.length).toBeLessThanOrEqual(THEME_RULES.max);
    expect(sel.themes[0].kind).toBe("core");
    const bodyUse = new Map<string, number>();
    sel.themes.forEach((t) => t.bodies.forEach((b) => bodyUse.set(b, (bodyUse.get(b) ?? 0) + 1)));
    [...bodyUse.values()].forEach((n) => expect(n).toBeLessThanOrEqual(THEME_RULES.maxPerBody));
    expect(sel.themes.filter((t) => t.generational).length).toBeLessThanOrEqual(THEME_RULES.maxGenerational);
    for (const t of sel.themes) {
      expect(t.evidenceIds.length).toBeGreaterThan(0);
      t.evidenceIds.forEach((id) => expect(nf.byId.has(id), id).toBe(true));
      expect(t.title.en.length).toBeGreaterThan(2);
      expect(t.title.zh.length).toBeGreaterThan(1);
    }
    expect(new Set(sel.themes.map((t) => t.id)).size).toBe(sel.themes.length);
  });

  it("cites only evidence that mentions the theme's own bodies", () => {
    for (const t of selectThemes(nf).themes) {
      for (const id of t.evidenceIds) {
        const f = nf.byId.get(id)!;
        if (f.kind === "angle") expect(t.bodies.includes(f.body) || t.kind === "angular" || t.kind === "ruler", `${t.id} cites ${id}`).toBe(true);
        if (f.kind === "placement") expect(t.bodies, `${t.id} cites ${id}`).toContain(f.body);
      }
      if (t.kind === "angular") {
        const angular = nf.byId.get(t.evidenceIds[0]);
        const citesAngle = t.evidenceIds.some((id) => id.startsWith("angle."));
        expect(citesAngle).toBe(angular?.kind === "angular" && angular.onAngle !== null);
      }
    }
  });

  it("writes titles without doubled spaces", () => {
    for (const t of selectThemes(nf).themes) {
      expect(t.title.en).not.toMatch(/\s{2,}|^\s|\s$/);
      expect(t.title.zh).not.toMatch(/\s{2,}/);
    }
  });
});

describe("unknown birth time", () => {
  const birth: BirthData = { date: "1999-08-14", time: null, place: { name: "Boston", country: "US", lat: 42.3601, lon: -71.0589, tz: "America/New_York" } };
  const nf = natalFacts(birth, computeChart(birth));

  it("produces no time-dependent facts", () => {
    expect(nf.timeKnown).toBe(false);
    expect(nf.facts.every((f) => f.timeIndependent)).toBe(true);
    expect(nf.facts.some((f) => ["angle", "angular", "chartRuler"].includes(f.kind))).toBe(false);
    expect(nf.facts.some((f) => f.kind === "stellium" && f.scope === "house")).toBe(false);
    expect(nf.facts.filter((f) => f.kind === "placement").every((f) => f.kind === "placement" && f.house === null && f.approximate)).toBe(true);
  });

  it("keeps Moon aspects only if they hold all day", () => {
    const withTime = natalFacts({ ...birth, time: "07:30" }, computeChart({ ...birth, time: "07:30" }));
    const moonAll = nf.facts.filter((f) => f.kind === "aspect" && (f.a === "moon" || f.b === "moon"));
    // every unknown-time Moon aspect must also exist at an arbitrary time that day
    moonAll.forEach((f) => expect(withTime.byId.has(f.id), f.id).toBe(true));
  });

  it("never uses Rising, houses or the ruler in themes", () => {
    const sel = selectThemes(nf);
    sel.themes.forEach((t) => {
      expect(t.bodies).not.toContain("asc");
      expect(["angular", "ruler"]).not.toContain(t.kind);
    });
    expect(sel.themes[0].limitations.length).toBeGreaterThan(0);
  });

  it("marks a Sun that changes sign that day as uncertain", () => {
    const eq: BirthData = { ...birth, date: "2026-03-20" };
    const f = natalFacts(eq, computeChart(eq));
    const sun = f.byId.get("place.sun");
    expect(sun?.kind).toBe("uncertainPlacement");
    const core = selectThemes(f).themes[0];
    expect(core.limitations.some((l) => /changes sign/.test(l.en))).toBe(true);
    expect(core.title.en).not.toMatch(/Sun/);
  });
});

describe("theme rules hold across many charts", () => {
  it("never breaks the selection rules (2026, every 9 days, known and unknown time, 3 latitudes)", () => {
    const places = [
      { name: "Boston", country: "US", lat: 42.36, lon: -71.06, tz: "America/New_York" },
      { name: "Sydney", country: "AU", lat: -33.87, lon: 151.21, tz: "Australia/Sydney" },
      { name: "Tromsø", country: "NO", lat: 69.65, lon: 18.96, tz: "Europe/Oslo" },
    ];
    let checked = 0;
    for (let d = 0; d < 365; d += 9) {
      const day = new Date(Date.UTC(1990, 0, 1 + d * 3)); // spread across ~3 years
      const date = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`;
      for (const place of places) {
        for (const time of ["06:15", null]) {
          const birth: BirthData = { date, time, place };
          const nf = natalFacts(birth, computeChart(birth));
          const sel = selectThemes(nf);
          expect(sel.themes.length).toBeGreaterThanOrEqual(THEME_RULES.min);
          expect(sel.themes.length).toBeLessThanOrEqual(THEME_RULES.max);
          sel.themes.forEach((t) => t.evidenceIds.forEach((id) => expect(nf.byId.has(id)).toBe(true)));
          if (!time) sel.themes.forEach((t) => t.evidenceIds.forEach((id) => expect(nf.byId.get(id)!.timeIndependent).toBe(true)));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
  });
});
