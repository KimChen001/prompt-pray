// Share privacy (overall review §7), the honest "welcome back", the QR target, and the claim checks
// for the common phrasings the review found missing (§1).
import { describe, expect, it } from "vitest";
import en from "@/lib/i18n/en";
import zh from "@/lib/i18n/zh";
import { analyze } from "@/lib/tarot/engine";
import { readingCard, readingShareText } from "@/lib/share/content";
import { greetingFor, daysBetween } from "@/lib/greeting";
import { qrTarget } from "@/components/PhoneQr";
import { emptyClaimFacts, addSign, addUncertain, findInconsistentClaim } from "@/lib/ai/claims";
import type { Reading } from "@/lib/tarot/types";
import type { CheckIn } from "@/lib/memory";

const reading: Reading = {
  id: "r1", kind: "reading", createdAt: "2026-10-09T12:00:00.000Z", localDate: "2026-10-09", spread: "triad", topic: "work",
  question: "Should I quit my job at Acme?", cards: [{ id: "swords-03", reversed: true }, { id: "major-13", reversed: false }, { id: "pentacles-10", reversed: false }], seed: "s",
};
const a = analyze(reading.spread, reading.cards, reading.topic);

describe("sharing: image and text follow the same defaults", () => {
  it("leaves the question out of both unless the person ticks it", () => {
    for (const [m, locale] of [[en, "en"], [zh, "zh"]] as const) {
      expect(readingShareText(reading, a, undefined, m, locale, { includeQuestion: false })).not.toContain("Acme");
      expect(readingCard(reading, a, undefined, m, locale, { includeQuestion: false }).quote).toBeUndefined();
      expect(readingShareText(reading, a, undefined, m, locale, { includeQuestion: true })).toContain("Acme");
      expect(readingCard(reading, a, undefined, m, locale, { includeQuestion: true }).quote).toContain("Acme");
    }
  });
});

describe("welcome back, from real records only", () => {
  const checkIn: CheckIn = { id: "c", action: "Talk to my manager", dueDate: "2026-10-09", createdAt: "x", status: "open" };
  it("says nothing personal on a first visit", () => {
    expect(greetingFor({ previousVisitLocal: null, todayLocal: "2026-10-09", dueCheckIns: [], readings: [], chats: [] })).toEqual({ kind: "first" });
  });
  it("prefers a due check-in, then the most recent reading or conversation", () => {
    expect(greetingFor({ previousVisitLocal: "2026-10-06", todayLocal: "2026-10-09", dueCheckIns: [checkIn], readings: [reading], chats: [] })).toMatchObject({ kind: "checkin", days: 3 });
    expect(greetingFor({ previousVisitLocal: "2026-10-06", todayLocal: "2026-10-09", dueCheckIns: [], readings: [reading], chats: [] })).toMatchObject({ kind: "reading", days: 3 });
    const chat = { id: "c1", createdAt: "x", updatedAt: "2026-10-09T13:00:00.000Z", title: "t", context: { chart: false, today: false, noteIds: [] }, turns: [] };
    expect(greetingFor({ previousVisitLocal: "2026-10-08", todayLocal: "2026-10-09", dueCheckIns: [], readings: [reading], chats: [chat] })).toMatchObject({ kind: "chat" });
    expect(daysBetween("2026-10-30", "2026-11-02")).toBe(3);
  });
});

describe("QR code target", () => {
  it("is always the site root: no path, query, question, reading id or key", () => {
    expect(qrTarget("https://moona.example.com/tarot/r/abc?code=secret", "http://localhost:3000")).toEqual({ url: "https://moona.example.com/", status: "public" });
  });
  it("labels development addresses honestly", () => {
    expect(qrTarget("", "http://localhost:3000")).toEqual({ url: "http://localhost:3000/", status: "local" });
    expect(qrTarget("", "http://192.168.1.20:3000")).toEqual({ url: "http://192.168.1.20:3000/", status: "test" });
    expect(qrTarget("http://moona.example.com", "http://localhost:3000").status).toBe("test"); // not HTTPS
  });
});

describe("claim checks catch common phrasings (Sun is in, Moon sits in, 太阳是…)", () => {
  const cf = emptyClaimFacts();
  addSign(cf, "sun", "aries");
  addSign(cf, "venus", "taurus");
  addUncertain(cf, "moon", ["cancer", "leo"]);

  it.each([
    "Your Sun is in Pisces, which invites quiet reflection.",
    "Your Sun sits in Pisces.",
    "Your Sun, which is in Pisces, softens you.",
    "your Sun sign is Pisces",
    "Venus is placed firmly in Gemini.",
    "a Sun-in-Pisces softness",
    "你的太阳是双鱼座，所以……",
    "太阳星座是双鱼。",
    "金星落在双子座。",
    "你的月亮在巨蟹座。", // uncertain Moon named alone
  ])("rejects %s", (text) => {
    expect(findInconsistentClaim(text, cf)).not.toBeNull();
  });

  it.each([
    "Your Sun is in Aries: you start things.",
    "Your Sun isn't in Pisces; it's in Aries.",
    "太阳不在双鱼座。",
    "Your Moon is in Cancer or Leo (the birth time decides).",
    "你的月亮在巨蟹座或狮子座。",
    "Venus in Taurus enjoys slow pleasures.",
  ])("accepts %s", (text) => {
    expect(findInconsistentClaim(text, cf)).toBeNull();
  });
});
