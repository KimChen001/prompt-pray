import { describe, expect, it } from "vitest";
import { birthInstant, formatOffset, isValidTimeZone, offsetAt, resolveLocal, zoneAbbreviation, type BirthData } from "@/lib/astro/birth";
import { computeChart } from "@/lib/astro/chart";
import { longitude } from "@/lib/astro/ephemeris";
import { signOf } from "@/lib/astro/zodiac";

const iso = (d: Date) => d.toISOString().replace(".000", "");

describe("resolveLocal (wall clock → UTC)", () => {
  it("handles a normal summer time", () => {
    const r = resolveLocal("1999-08-14", "07:30", "America/New_York");
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(iso(r.result.utc)).toBe("1999-08-14T11:30:00Z");
      expect(r.result.offset).toBe(-240);
    }
  });
  it("flags a time that happened twice (fall back)", () => {
    const r = resolveLocal("2026-11-01", "01:30", "America/New_York");
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") {
      expect(r.options.map((o) => iso(o.utc))).toEqual(["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]);
      expect(r.options.map((o) => o.offset)).toEqual([-240, -300]);
    }
  });
  it("flags a time that never happened (spring forward) and suggests the shifted time", () => {
    const r = resolveLocal("2026-03-08", "02:30", "America/New_York");
    expect(r.status).toBe("nonexistent");
    if (r.status === "nonexistent") {
      expect(r.suggestedTime).toBe("03:30");
      expect(iso(r.suggestion.utc)).toBe("2026-03-08T07:30:00Z");
    }
  });
  it("handles half-hour zones and zones without DST", () => {
    const k = resolveLocal("2010-01-15", "03:05", "Asia/Kolkata");
    expect(k.status === "ok" && iso(k.result.utc)).toBe("2010-01-14T21:35:00Z");
    const s = resolveLocal("2003-06-01", "12:00", "Asia/Shanghai");
    expect(s.status === "ok" && iso(s.result.utc)).toBe("2003-06-01T04:00:00Z");
  });
  it("uses historical rules before 1970 (UK British Standard Time, 1968–71)", () => {
    expect(offsetAt(Date.UTC(1965, 10, 3, 18, 20), "Europe/London")).toBe(0);
    expect(offsetAt(Date.UTC(1969, 11, 1, 12, 0), "Europe/London")).toBe(60);
  });
  it("formats offsets and zone names", () => {
    expect(formatOffset(-240)).toBe("UTC−4");
    expect(formatOffset(330)).toBe("UTC+5:30");
    expect(formatOffset(0)).toBe("UTC");
    expect(zoneAbbreviation(new Date("1999-08-14T11:30:00Z"), "America/New_York")).toBe("EDT");
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});

const boston: BirthData["place"] = { name: "Boston", admin1: "Massachusetts", country: "US", lat: 42.3601, lon: -71.0589, tz: "America/New_York" };

describe("computeChart / Big Three", () => {
  it("computes the Big Three when the time is known", () => {
    const c = computeChart({ date: "1999-08-14", time: "07:30", place: boston });
    expect(c.timeKnown).toBe(true);
    expect(c.bigThree.sun.placement?.sign).toBe("leo");
    expect(c.bigThree.moon.placement?.sign).toBe("virgo");
    expect(c.bigThree.rising?.placement?.sign).toBe("virgo");
    expect(c.cusps).toHaveLength(12);
    expect(c.positions.sun.house).toBeGreaterThanOrEqual(1);
  });
  it("never invents a Rising sign when the time is unknown", () => {
    const c = computeChart({ date: "1999-08-14", time: null, place: boston });
    expect(c.timeKnown).toBe(false);
    expect(c.bigThree.rising).toBeNull();
    expect(c.asc).toBeNull();
    expect(c.cusps).toBeNull();
    expect(c.positions.mars.house).toBeNull();
  });
  it("offers both Sun signs on an ingress day (2026 March equinox, New York)", () => {
    const c = computeChart({ date: "2026-03-20", time: null, place: boston });
    expect(c.bigThree.sun.options).toEqual(["pisces", "aries"]);
    expect(c.bigThree.sun.changesAt).toMatch(/^1[01]:\d{2}$/); // equinox 14:46 UTC = 10:46 EDT
  });
  it("offers both Moon signs when the Moon changes sign that day", () => {
    // Find a January 2026 day where the Moon changes sign during the New York day (EST = UTC−5).
    let date = "";
    for (let d = 1; d <= 28 && !date; d++) {
      const day = `2026-01-${String(d).padStart(2, "0")}`;
      const midnight = Date.parse(`${day}T05:00:00Z`);
      const atStart = signOf(longitude("moon", new Date(midnight)));
      const atEnd = signOf(longitude("moon", new Date(midnight + 86400e3 - 60e3)));
      if (atStart !== atEnd) date = day;
    }
    expect(date).not.toBe("");
    const c = computeChart({ date, time: null, place: boston });
    expect(c.bigThree.moon.options).toHaveLength(2);
    expect(c.bigThree.moon.changesAt).toMatch(/^\d{2}:\d{2}$/);
  });
  it("respects the user's choice on an ambiguous time", () => {
    const base = { date: "2026-11-01", time: "01:30", place: boston } as BirthData;
    expect(birthInstant(base)?.offset).toBe(-240);
    expect(birthInstant({ ...base, offsetChoice: -300 })?.offset).toBe(-300);
  });
  it("falls back to Whole Sign above the polar circle", () => {
    const tromso = { name: "Tromsø", country: "NO", lat: 69.6492, lon: 18.9553, tz: "Europe/Oslo" };
    const c = computeChart({ date: "1990-06-21", time: "12:00", place: tromso }, "placidus");
    expect(c.houseSystem).toBe("whole");
    expect(c.houseFallback).toBe(true);
    expect(c.cusps).toHaveLength(12);
  });
});
