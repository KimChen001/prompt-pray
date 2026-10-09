import { describe, expect, it } from "vitest";
import { formatLocalDate, localDateKey, parseLocalDate } from "@/lib/time";
import { detectCrisis, guessHelpRegion } from "@/lib/safety";

describe("localDateKey (plan v0.2 §4.1)", () => {
  // 2026-10-24 06:30 UTC = 23:30 on the 23rd in Los Angeles, 02:30 on the 24th in New York
  const instant = new Date(Date.UTC(2026, 9, 24, 6, 30));
  it("uses the user's calendar day, not the UTC day", () => {
    expect(localDateKey(instant, "America/Los_Angeles")).toBe("2026-10-23");
    expect(localDateKey(instant, "America/New_York")).toBe("2026-10-24");
    expect(localDateKey(instant, "Asia/Shanghai")).toBe("2026-10-24");
    expect(localDateKey(instant, "Asia/Kolkata")).toBe("2026-10-24");
  });
  it("rolls over at local midnight in LA", () => {
    expect(localDateKey(new Date(Date.UTC(2026, 9, 24, 6, 59)), "America/Los_Angeles")).toBe("2026-10-23");
    expect(localDateKey(new Date(Date.UTC(2026, 9, 24, 7, 1)), "America/Los_Angeles")).toBe("2026-10-24");
  });
  it("handles US DST changeover days", () => {
    // 2026-03-08: clocks jump 02:00→03:00 in New York (UTC−5 → UTC−4)
    expect(localDateKey(new Date(Date.UTC(2026, 2, 8, 4, 59)), "America/New_York")).toBe("2026-03-07");
    expect(localDateKey(new Date(Date.UTC(2026, 2, 8, 5, 1)), "America/New_York")).toBe("2026-03-08");
    // 2026-11-01: clocks fall back; midnight is still 04:00 UTC (UTC−4)
    expect(localDateKey(new Date(Date.UTC(2026, 10, 1, 3, 59)), "America/New_York")).toBe("2026-10-31");
    expect(localDateKey(new Date(Date.UTC(2026, 10, 1, 4, 1)), "America/New_York")).toBe("2026-11-01");
  });
  it("parses and formats without going through Date", () => {
    expect(parseLocalDate("2026-10-24")).toEqual({ year: 2026, month: 10, day: 24 });
    expect(formatLocalDate("2026-10-24", "en")).toBe("Oct 24, 2026");
    expect(formatLocalDate("2026-10-24", "zh")).toBe("2026年10月24日");
    expect(() => parseLocalDate("10/24/2026")).toThrow();
  });
});

describe("detectCrisis (plan v0.2 §4.3)", () => {
  const shouldFlag = [
    "I want to die",
    "thinking about suicide",
    "I keep wanting to kill myself",
    "I don't want to live anymore",
    "should I end it all",
    "I've been self-harming again",
    "no reason to live",
    "我不想活了",
    "最近总是想死",
    "我想自杀",
    "活不下去了",
  ];
  const shouldNotFlag = [
    "What does the Death card mean for my career?",
    "I'm dying to know if he likes me",
    "My presentation killed it today",
    "I'm dead tired of this job",
    "Should I end my lease early or stay?",
    "死神牌代表什么？",
    "这份工作让我累死了",
  ];
  it.each(shouldFlag)("flags: %s", (t) => expect(detectCrisis(t)).toBe(true));
  it.each(shouldNotFlag)("does not flag: %s", (t) => expect(detectCrisis(t)).toBe(false));
});

describe("guessHelpRegion", () => {
  it("uses the device time zone", () => {
    expect(guessHelpRegion("America/New_York")).toBe("US");
    expect(guessHelpRegion("America/Indiana/Indianapolis")).toBe("US");
    expect(guessHelpRegion("Pacific/Honolulu")).toBe("US");
    expect(guessHelpRegion("America/Toronto")).toBe("other");
    expect(guessHelpRegion("Asia/Shanghai")).toBe("other");
  });
});
