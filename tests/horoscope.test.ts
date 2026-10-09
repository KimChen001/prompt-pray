import { describe, expect, it } from "vitest";
import { aspectBetween, dailyFacts, dayTone, signAspect, solarHouse } from "@/lib/astro/transits";
import { composeHoroscope, factLine } from "@/lib/astro/horoscope";
import { skyForDay } from "@/lib/astro/sky";
import { computeChart } from "@/lib/astro/chart";
import { SIGNS } from "@/lib/astro/zodiac";

const boston = { name: "Boston", country: "US", lat: 42.3601, lon: -71.0589, tz: "America/New_York" };
const hackathon = skyForDay("2026-10-28", "America/New_York", new Date("2026-10-28T14:00:00Z"));

const complete = (t: { en: string; zh: string }) => {
  expect(t.en.trim().length).toBeGreaterThan(10);
  expect(t.zh.trim().length).toBeGreaterThan(5);
  expect(t.en).not.toMatch(/[{}]|undefined/);
  expect(t.zh).not.toMatch(/[{}]|undefined/);
};

describe("aspects", () => {
  it("detects degree aspects within the orb", () => {
    expect(aspectBetween(10, 12, 3)).toEqual({ aspect: "conjunction", orb: 2 });
    expect(aspectBetween(10, 128, 3)).toMatchObject({ aspect: "trine" });
    expect(aspectBetween(350, 82, 3)).toMatchObject({ aspect: "square" }); // across 0°
    expect(aspectBetween(10, 195, 6)).toMatchObject({ aspect: "opposition", orb: 5 });
    expect(aspectBetween(10, 50, 3)).toBeNull();
  });
  it("detects whole-sign aspects", () => {
    expect(signAspect("leo", "leo")).toBe("conjunction");
    expect(signAspect("leo", "libra")).toBe("sextile");
    expect(signAspect("leo", "scorpio")).toBe("square");
    expect(signAspect("leo", "sagittarius")).toBe("trine");
    expect(signAspect("leo", "aquarius")).toBe("opposition");
    expect(signAspect("leo", "virgo")).toBeNull();
  });
  it("counts solar houses from the Sun sign", () => {
    expect(solarHouse("leo", "leo")).toBe(1);
    expect(solarHouse("scorpio", "leo")).toBe(4);
    expect(solarHouse("cancer", "leo")).toBe(12);
  });
});

describe("daily facts (hackathon day, Oct 28 2026)", () => {
  it("uses the natal chart when there is one", () => {
    const natal = computeChart({ date: "1999-08-14", time: "07:30", place: boston });
    const facts = dailyFacts({ mode: "natal", sunSign: "leo", natal }, hackathon);
    expect(facts.some((f) => f.kind === "retrograde" && f.planet === "mercury")).toBe(true);
    expect(facts.some((f) => f.kind === "retrograde" && f.planet === "venus")).toBe(true);
    expect(facts.filter((f) => f.kind === "moonHouse")).toHaveLength(1);
    for (let i = 1; i < facts.length; i++) expect(facts[i - 1].weight).toBeGreaterThanOrEqual(facts[i].weight);
    facts.forEach((f) => complete(factLine(f)));
  });
  it("is deterministic", () => {
    const a = composeHoroscope(dailyFacts({ mode: "sign", sunSign: "scorpio" }, hackathon));
    const b = composeHoroscope(dailyFacts({ mode: "sign", sunSign: "scorpio" }, hackathon));
    expect(a).toEqual(b);
  });
  it.each(SIGNS)("writes a complete horoscope for %s", (sign) => {
    const facts = dailyFacts({ mode: "sign", sunSign: sign }, hackathon);
    const h = composeHoroscope(facts);
    expect(["flow", "tension", "focus"]).toContain(h.tone);
    [h.overall, h.love, h.work].forEach(complete);
    expect(h.why.length).toBeGreaterThan(0);
    h.why.forEach((w) => complete(w.line));
  });
});

describe("tone", () => {
  it("is 'focus' when there are no aspects", () => {
    expect(dayTone([])).toBe("focus");
  });
});

describe("every day of 2026 produces complete text", () => {
  it("covers all sky events and houses without gaps", () => {
    const natal = computeChart({ date: "1999-08-14", time: "07:30", place: boston });
    for (let d = 0; d < 365; d += 3) {
      const date = new Date(Date.UTC(2026, 0, 1 + d));
      const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
      const sky = skyForDay(key, "America/New_York");
      const h = composeHoroscope(dailyFacts({ mode: "natal", sunSign: "leo", natal }, sky));
      [h.overall, h.love, h.work, ...h.why.map((w) => w.line)].forEach(complete);
    }
  });
});
