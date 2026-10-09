import { describe, expect, it } from "vitest";
import sky2026 from "./fixtures/sky-2026.sweph.json";
import { nextLocalDate, phaseName, skyForDay } from "@/lib/astro/sky";
import { SIGNS } from "@/lib/astro/zodiac";

const minutesApart = (a: Date, b: string) => Math.abs(a.getTime() - Date.parse(b)) / 60e3;
const utcDay = (iso: string) => iso.slice(0, 10);

describe("phaseName", () => {
  it("bins the phase angle into eight phases", () => {
    expect(phaseName(0)).toBe("new");
    expect(phaseName(359)).toBe("new");
    expect(phaseName(30)).toBe("waxingCrescent");
    expect(phaseName(90)).toBe("firstQuarter");
    expect(phaseName(180)).toBe("full");
    expect(phaseName(200)).toBe("full");
    expect(phaseName(270)).toBe("lastQuarter");
    expect(phaseName(320)).toBe("waningCrescent");
  });
});

describe("skyForDay vs Swiss Ephemeris (2026)", () => {
  it.each(sky2026.newMoons)("finds the new moon at %s", (iso) => {
    const ev = skyForDay(utcDay(iso), "UTC").events.find((e) => e.kind === "lunation" && e.phase === "new");
    expect(ev && minutesApart(ev.at, iso)).toBeLessThan(5);
  });
  it.each(sky2026.fullMoons)("finds the full moon at %s", (iso) => {
    const ev = skyForDay(utcDay(iso), "UTC").events.find((e) => e.kind === "lunation" && e.phase === "full");
    expect(ev && minutesApart(ev.at, iso)).toBeLessThan(5);
  });
  it.each(sky2026.sunIngresses)("finds the Sun entering sign $sign at $at", ({ sign, at }) => {
    const ev = skyForDay(utcDay(at), "UTC").events.find((e) => e.kind === "ingress" && e.planet === "sun");
    expect(ev?.sign).toBe(SIGNS[sign]);
    expect(ev && minutesApart(ev.at, at)).toBeLessThan(5);
  });
  const stations = Object.entries(sky2026.stations).flatMap(([planet, s]) => [
    ...s.retrograde.map((at) => ({ planet, at, kind: "stationRetrograde" })),
    ...s.direct.map((at) => ({ planet, at, kind: "stationDirect" })),
  ]);
  it.each(stations)("finds $planet $kind at $at", ({ planet, at, kind }) => {
    // A station is the moment motion is ~0, so its exact time is soft; allow 3 hours.
    const day = skyForDay(utcDay(at), "UTC");
    const prev = skyForDay(utcDay(new Date(Date.parse(at) - 86400e3).toISOString()), "UTC");
    const next = skyForDay(nextLocalDate(utcDay(at)), "UTC");
    const ev = [...prev.events, ...day.events, ...next.events].find((e) => e.kind === kind && "planet" in e && e.planet === planet);
    expect(ev && minutesApart(ev.at, at)).toBeLessThan(180);
  });
});

describe("local days", () => {
  it("assigns events to the user's calendar day", () => {
    // Mercury stations retrograde 2026-10-24 07:13 UTC = 00:13 in Los Angeles on Oct 24, 03:13 in New York.
    const la = skyForDay("2026-10-24", "America/Los_Angeles").events.find((e) => e.kind === "stationRetrograde");
    const laPrev = skyForDay("2026-10-23", "America/Los_Angeles").events.find((e) => e.kind === "stationRetrograde");
    expect(la && "planet" in la && la.planet).toBe("mercury");
    expect(laPrev).toBeUndefined();
  });
  it("describes hackathon day (Oct 28, 2026, Cambridge MA)", () => {
    const d = skyForDay("2026-10-28", "America/New_York", new Date("2026-10-28T14:00:00Z"));
    expect(d.retrograde).toEqual(expect.arrayContaining(["mercury", "venus"]));
    expect(d.moon.phase).toBe("waningGibbous");
    expect(d.sun.sign).toBe("scorpio");
    expect(d.next[0].phase).toBe("new");
  });
  it("uses local noon when 'now' is outside the requested day", () => {
    const d = skyForDay("2026-10-28", "America/New_York", new Date("2026-01-01T00:00:00Z"));
    expect(d.at.toISOString()).toBe("2026-10-28T16:00:00.000Z");
  });
  it("adds calendar days without time zones", () => {
    expect(nextLocalDate("2026-10-31")).toBe("2026-11-01");
    expect(nextLocalDate("2026-12-31")).toBe("2027-01-01");
    expect(nextLocalDate("2028-02-28")).toBe("2028-02-29");
  });
});
