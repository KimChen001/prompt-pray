import { describe, expect, it } from "vitest";
import en from "@/lib/i18n/en";
import zh from "@/lib/i18n/zh";
import { bigThreeCard, dailyCard, matchCard, readingCard } from "@/lib/share/content";
import { analyze } from "@/lib/tarot/engine";
import { computeChart } from "@/lib/astro/chart";
import { computeMatch } from "@/lib/astro/match";
import type { Reading } from "@/lib/tarot/types";
import type { SavedMatch } from "@/lib/store";

const reading: Reading = {
  id: "r1", kind: "reading", createdAt: "2026-10-09T12:00:00Z", localDate: "2026-10-09", spread: "triad", topic: "work",
  question: "Should I leave my job at Acme?", seed: "s",
  cards: [{ id: "swords-03", reversed: true }, { id: "major-13", reversed: false }, { id: "pentacles-10", reversed: false }],
};
const birth = { date: "1994-03-21", time: "08:15", place: { name: "Cambridge", country: "US", lat: 42.3751, lon: -71.1056, tz: "America/New_York" } };

describe("share image content", () => {
  it("leaves the question off unless the person opts in", () => {
    const a = analyze(reading.spread, reading.cards, reading.topic);
    const off = readingCard(reading, a, undefined, en, "en", { includeQuestion: false });
    expect(JSON.stringify(off)).not.toContain("Acme");
    expect(off.cards).toHaveLength(3);
    expect(off.cards![0].name).toContain("(Reversed)");
    expect(off.cards!.every((c) => c.line.length > 10)).toBe(true);
    const on = readingCard(reading, a, undefined, en, "en", { includeQuestion: true });
    expect(on.quote).toBe(reading.question);
    expect(readingCard(reading, a, undefined, zh, "zh", { includeQuestion: false }).title).toBe(zh.spreads.triad.name);
  });

  it("shows only the Big Three sign names from a chart", () => {
    const card = bigThreeCard(computeChart(birth), en, "en");
    expect(card.rows!.map((r) => r.value)).toEqual(["Aries", "Cancer", "Taurus"]);
    const json = JSON.stringify(card);
    for (const secret of ["1994", "08:15", "Cambridge", "42.37", "71.10"]) expect(json).not.toContain(secret);
    // unknown time: no Rising, and an uncertain sign is shown as both options
    const noTime = bigThreeCard(computeChart({ ...birth, time: null }), en, "en");
    expect(noTime.rows![2].value).toBe("?");
  });

  it("keeps the other person's nickname and birth details off a match image by default", () => {
    const b = { name: "Sam Rivera", date: "1996-11-02", time: null, place: null };
    const result = computeMatch({ name: "", ...birth }, b);
    const saved: SavedMatch = { id: "m", createdAt: "", a: { fromProfile: true, name: "" }, b, result };
    const off = matchCard(saved, en, { includeName: false });
    expect(off.title).toBe("You & Them");
    const json = JSON.stringify(off);
    for (const secret of ["Sam", "1996", "1994"]) expect(json).not.toContain(secret);
    expect(off.big).toBe(String(result.score));
    expect(off.rows!.map((r) => r.label)).toEqual(["Emotional", "Communication", "Attraction"]);
    expect(off.footer).toContain("not a prediction");
    expect(matchCard(saved, en, { includeName: true }).title).toBe("You & Sam Rivera");
  });

  it("makes a daily-card image with one card and its line", () => {
    const d = dailyCard("2026-10-09", "major-17", false, "The Star", "Hope returns.", en, "en");
    expect(d.cards).toEqual([{ id: "major-17", reversed: false, name: "The Star", line: "Hope returns." }]);
    expect(d.subtitle).toContain("2026");
  });
});
