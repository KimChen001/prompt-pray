import { describe, expect, it } from "vitest";
import { aspectBetween, aspectThroughout, dailyFacts, dayTone, signAspect, solarHouse, subjectFromBirth } from "@/lib/astro/transits";
import { composeHoroscope, factLine } from "@/lib/astro/horoscope";
import { dayMidpoint, skyForDay } from "@/lib/astro/sky";
import { computeChart } from "@/lib/astro/chart";
import { allPositions } from "@/lib/astro/ephemeris";
import { SIGNS } from "@/lib/astro/zodiac";
import { dayHoroscope, horoscopeBody, horoscopeCacheKey } from "@/lib/astro/horoscope-day";
import { checkFacts, horoscopeClaims, parseHoroscopeRequest, referenceSky, validateHoroscope, type WireFact } from "@/lib/ai/horoscope-prompt";
import type { BirthData } from "@/lib/astro/birth";

const boston = { name: "Boston", country: "US", lat: 42.3601, lon: -71.0589, tz: "America/New_York" };
const hackathon = skyForDay("2026-10-28", "America/New_York", new Date("2026-10-28T14:00:00Z"));

const complete = (t: { en: string; zh: string }) => {
  expect(t.en.trim().length).toBeGreaterThan(10);
  expect(t.zh.trim().length).toBeGreaterThan(5);
  expect(t.en).not.toMatch(/[{}]|undefined/);
  expect(t.zh).not.toMatch(/[{}]|undefined/);
};

function lonsAt(sky: ReturnType<typeof skyForDay>) {
  const p = allPositions(sky.at);
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.lon])) as Record<keyof typeof p, number>;
}

describe("aspects", () => {
  it("detects degree aspects within the orb", () => {
    expect(aspectBetween(10, 12, 3)).toEqual({ aspect: "conjunction", orb: 2 });
    expect(aspectBetween(10, 128, 3)).toMatchObject({ aspect: "trine" });
    expect(aspectBetween(350, 82, 3)).toMatchObject({ aspect: "square" }); // across 0°
    expect(aspectBetween(10, 195, 6)).toMatchObject({ aspect: "opposition", orb: 5 });
    expect(aspectBetween(10, 50, 3)).toBeNull();
  });
  it("keeps an aspect across samples only if every sample has it, with the widest orb", () => {
    expect(aspectThroughout(0, [119, 120, 121.5], 3)).toEqual({ aspect: "trine", orb: 1.5 });
    expect(aspectThroughout(0, [119, 124], 3)).toBeNull();
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
    const facts = dailyFacts(subjectFromBirth({ date: "1999-08-14", time: "07:30", place: boston }, "placidus"), hackathon);
    expect(facts.some((f) => f.kind === "retrograde" && f.planet === "mercury")).toBe(true);
    expect(facts.some((f) => f.kind === "retrograde" && f.planet === "venus")).toBe(true);
    expect(facts.filter((f) => f.kind === "moonHouse")).toHaveLength(1);
    expect(facts.find((f) => f.kind === "moonHouse")).toMatchObject({ basis: "natal" });
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
  it("covers all sky events and houses without gaps (known and unknown birth time)", () => {
    const subjects = [
      subjectFromBirth({ date: "1999-08-14", time: "07:30", place: boston }, "placidus"),
      subjectFromBirth({ date: "1999-08-14", time: null, place: boston }, "placidus"),
    ];
    for (let d = 0; d < 365; d += 3) {
      const date = new Date(Date.UTC(2026, 0, 1 + d));
      const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
      const sky = skyForDay(key, "America/New_York");
      for (const subject of subjects) {
        const h = composeHoroscope(dailyFacts(subject, sky));
        [h.overall, h.love, h.work, ...h.why.map((w) => w.line)].forEach(complete);
      }
    }
  });
});

// Overall review §3: an unknown birth time keeps its limits in the daily horoscope.
describe("unknown birth time", () => {
  const tz = "America/New_York";
  const date = "2026-10-09";
  const sky = skyForDay(date, tz, dayMidpoint(date, tz));
  const noTime: BirthData = { date: "1990-01-01", time: null, place: boston };

  it("keeps an aspect to the natal Moon only if it holds across the whole birth day", () => {
    // The review's case: at local noon Venus is trine the natal Moon (1.61°), but not all day.
    const noon = computeChart(noTime);
    expect(aspectBetween(lonsAt(sky).venus, noon.positions.moon.lon, 3)).toMatchObject({ aspect: "trine" });
    const subject = subjectFromBirth(noTime, "placidus");
    const facts = dailyFacts(subject, sky);
    expect(facts.some((f) => f.kind === "aspect" && f.transit === "venus" && f.natal === "moon")).toBe(false);
    for (const f of facts) {
      if (f.kind !== "aspect") continue;
      expect(f.sampled).toBe(true);
      expect(aspectThroughout(lonsAt(sky)[f.transit], subject.natal!.points[f.natal]!, 6)).not.toBeNull();
    }
  });
  it("uses solar houses, says so, and never uses an Ascendant", () => {
    const facts = dailyFacts(subjectFromBirth(noTime, "placidus"), sky);
    const moon = facts.find((f) => f.kind === "moonHouse");
    expect(moon).toMatchObject({ basis: "solar" });
    expect(factLine(moon!).en).toContain("solar house (counted from your Sun sign)");
    expect(factLine(moon!).zh).toContain("太阳宫");
    expect(facts.some((f) => f.kind === "aspect" && f.natal === "asc")).toBe(false);
  });
  it("keeps both Sun signs on a sign-change birthday and drops house facts", () => {
    const d = dayHoroscope({ birth: { date: "1999-08-23", time: null, place: boston }, houseSystem: "placidus" }, date, tz);
    expect(d.subject.sunSign).toBeNull();
    expect(d.subject.sunOptions).toEqual(["leo", "virgo"]);
    expect(d.wire.sun).toEqual(["leo", "virgo"]);
    expect(d.facts.some((f) => f.kind === "moonHouse" || (f.kind === "event" && f.house !== null))).toBe(false);
  });
});

describe("saved horoscope cache key (review §6)", () => {
  const tz = "America/New_York";
  const date = "2026-10-09";
  const key = (birth: BirthData, system: "placidus" | "whole" = "placidus", zone = tz, locale: "en" | "zh" = "en") =>
    horoscopeCacheKey(dayHoroscope({ birth, houseSystem: system }, date, zone), date, zone, locale);
  const fallBack = (offsetChoice: number): BirthData => ({ date: "2020-11-01", time: "01:30", place: boston, offsetChoice });

  it("separates both readings of an ambiguous DST time", () => {
    expect(key(fallBack(-240))).not.toBe(key(fallBack(-300)));
  });
  it("changes with the house system, time zone, language, rules and birth details", () => {
    const b: BirthData = { date: "1999-08-14", time: "07:30", place: boston };
    const base = key(b);
    expect(key(b, "whole")).not.toBe(base);
    expect(key(b, "placidus", "Asia/Shanghai")).not.toBe(base);
    expect(key(b, "placidus", tz, "zh")).not.toBe(base);
    expect(key({ ...b, time: "07:31" })).not.toBe(base);
    expect(key({ ...b, place: { ...boston, tz: "America/Chicago" } })).not.toBe(base);
    // Versions are stored with the saved text, not in the key: a version change keeps the text (and offers an update).
    expect(base).not.toMatch(/horoscope@|claims@|rules@/);
  });
  it("ignores the house system without a birth time (it can't change anything)", () => {
    const b: BirthData = { date: "1999-08-14", time: null, place: boston };
    expect(key(b, "whole")).toBe(key(b, "placidus"));
  });
});

describe("server checks for the AI horoscope (review §1)", () => {
  const tz = "America/New_York";
  const date = "2026-10-28";
  const wire = (input: Parameters<typeof dayHoroscope>[0]) => JSON.parse(JSON.stringify(horoscopeBody(dayHoroscope(input, date, tz), date, tz, "en")));
  const known = { birth: { date: "1999-08-14", time: "07:30", place: boston }, houseSystem: "placidus" as const };

  it("accepts the browser's facts for natal, unknown-time and Sun-sign subjects", () => {
    for (const input of [known, { birth: { date: "1990-01-01", time: null, place: boston }, houseSystem: "placidus" as const }, { sunSign: "scorpio" as const }]) {
      const r = parseHoroscopeRequest(wire(input));
      expect(r).not.toBeNull();
      expect(checkFacts(r!, referenceSky(date, tz))).toBeNull();
    }
  });
  it("rejects facts that don't match the recalculated sky or the subject's limits", () => {
    const sky = referenceSky(date, tz);
    const r = parseHoroscopeRequest(wire({ sunSign: "scorpio" }))!;
    const other = SIGNS.find((s) => s !== sky.moon.placement.sign)!;
    const fake: WireFact = { kind: "moonHouse", house: 1, basis: "solar", sign: other };
    expect(checkFacts({ ...r, facts: [fake] }, sky)).toBe("moon sign");
    const moonHere: WireFact = { kind: "moonHouse", house: solarHouse(sky.moon.placement.sign, "scorpio"), basis: "natal", sign: sky.moon.placement.sign };
    expect(checkFacts({ ...r, facts: [moonHere] }, sky)).toBe("natal house without a birth time");
    expect(checkFacts({ ...r, facts: [{ ...moonHere, basis: "solar", house: (moonHere.house % 12) + 1 }] }, sky)).toBe("solar house");
    const notRetro = (["mercury", "venus", "mars"] as const).find((p) => !sky.retrograde.includes(p));
    if (notRetro) expect(checkFacts({ ...r, facts: [{ kind: "retrograde", planet: notRetro }] }, sky)).toBe("retrograde");
    // A Rising sign can't be claimed without a birth time.
    expect(parseHoroscopeRequest({ ...wire({ sunSign: "scorpio" }), subject: { mode: "natal", timeKnown: false, sun: ["leo"], rising: "aries" } })).toBeNull();
  });
  it("rejects AI text that contradicts the facts", () => {
    const r = parseHoroscopeRequest(wire(known))!;
    const claims = horoscopeClaims(r, referenceSky(date, tz));
    const ok = { overall: "A steady day to reflect.", love: "Say plainly what you feel.", work: "Finish one thing fully." };
    expect(validateHoroscope(ok, claims)).toEqual(ok);
    expect(validateHoroscope({ ...ok, overall: "Your Sun is in Pisces, so rest." }, claims)).toBeNull();
    expect(validateHoroscope({ ...ok, love: "With your Aries Rising, speak first." }, claims)).toBeNull();
    expect(validateHoroscope({ ...ok, work: "The Moon sits at 14° today." }, claims)).toBeNull();
  });
});
