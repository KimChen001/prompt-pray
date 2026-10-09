import { describe, expect, it } from "vitest";
import { DECK, getCard } from "@/lib/tarot/deck";
import { fnv1a, mulberry32, rngFromSeed, shuffle } from "@/lib/tarot/rng";
import { SPREADS, suggestSpread } from "@/lib/tarot/spreads";
import { affinity, analyze, cardWeight, findPatterns, scoreChoice } from "@/lib/tarot/engine";
import { dailyCard } from "@/lib/tarot/daily";

const pick = (id: string, reversed = false) => ({ card: getCard(id), reversed });

describe("deck", () => {
  it("has 78 unique cards", () => {
    expect(DECK).toHaveLength(78);
    expect(new Set(DECK.map((c) => c.id)).size).toBe(78);
  });
});

describe("rng", () => {
  it("matches the mini-program FNV-1a hash", () => {
    expect(fnv1a("")).toBe(2166136261);
    expect(fnv1a("a")).toBe(0xe40c292c);
  });
  it("is deterministic for the same seed", () => {
    const a = shuffle(DECK, rngFromSeed("seed-1")).map((c) => c.id);
    const b = shuffle(DECK, rngFromSeed("seed-1")).map((c) => c.id);
    const c = shuffle(DECK, rngFromSeed("seed-2")).map((c) => c.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
  it("shuffle keeps every card and does not mutate input", () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffle(input, mulberry32(7));
    expect([...out].sort()).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("spreads", () => {
  it("keeps all four original spreads", () => {
    expect(Object.keys(SPREADS)).toEqual(["single", "triad", "relate", "choice"]);
    Object.values(SPREADS).forEach((s) => expect(s.positions).toHaveLength(s.count));
  });
  it("suggests a spread from the question", () => {
    expect(suggestSpread("")).toBe("single");
    expect(suggestSpread("Should I take the new offer or stay?")).toBe("choice");
    expect(suggestSpread("该接受新的机会，还是留下来？")).toBe("choice");
    expect(suggestSpread("What do I need to know about my relationship?")).toBe("relate");
    expect(suggestSpread("What should I focus on?")).toBe("single");
  });
});

describe("scoring (plan v0.2 §3.2)", () => {
  it("weights majors, reversals and topic relevance", () => {
    expect(cardWeight(getCard("major-00"), false, "general")).toBe(3);
    expect(cardWeight(getCard("major-00"), true, "general")).toBeCloseTo(2.1);
    expect(cardWeight(getCard("cups-02"), false, "love")).toBeCloseTo(1.4);
    expect(cardWeight(getCard("cups-02"), false, "work")).toBe(1);
  });
  it("computes elemental affinity", () => {
    expect(affinity("fire", "fire")).toBe(0.5);
    expect(affinity("fire", "air")).toBe(1);
    expect(affinity("water", "fire")).toBe(-1);
    expect(affinity("fire", "earth")).toBe(-0.5);
    expect(affinity(null, "fire")).toBe(0);
  });
  it("lets the Key factor and Outcome tip the choice", () => {
    // A = Wands (fire), B = Cups (water); key and outcome are Swords (air) which support fire, oppose nothing water-wise (−0.5)
    const r = scoreChoice([pick("wands-03"), pick("cups-03"), pick("swords-04"), pick("swords-05")], "general");
    expect(r.scoreA).toBe(2); // 1 + 0.5*1 + 0.5*1
    expect(r.scoreB).toBe(0.5); // 1 + 0.5*-0.5 + 0.5*-0.5
    expect(r.verdict).toBe("A");
  });
  it("calls it close when scores are within 0.5", () => {
    const r = scoreChoice([pick("wands-03"), pick("wands-04"), pick("major-01"), pick("major-02")], "general");
    expect(r.verdict).toBe("close");
  });
});

describe("patterns", () => {
  it("detects reversals, majors, suits and numbers", () => {
    expect(findPatterns([pick("major-00", true), pick("major-01", true), pick("major-02", true)])).toEqual(
      expect.arrayContaining(["allReversed", "manyMajors"]),
    );
    expect(findPatterns([pick("cups-03"), pick("cups-05"), pick("wands-03")])).toEqual(
      expect.arrayContaining(["noMajors", "sameSuit", "repeatedNumber"]),
    );
  });
});

describe("analyze", () => {
  it("produces bilingual text for every spread", () => {
    for (const spread of Object.values(SPREADS)) {
      const drawn = DECK.slice(10, 10 + spread.count).map((c, i) => ({ id: c.id, reversed: i % 2 === 1 }));
      const a = analyze(spread.id, drawn, "love");
      expect(a.perCard).toHaveLength(spread.count);
      expect(a.summary.en.length).toBeGreaterThan(20);
      expect(a.summary.zh.length).toBeGreaterThan(10);
      expect(a.action.en).toBeTruthy();
      expect(a.perCard[0].topicLine?.zh).toBeTruthy();
      expect(a.choice === null).toBe(spread.id !== "choice");
    }
  });
  it("rejects the wrong number of cards", () => {
    expect(() => analyze("triad", [{ id: "major-00", reversed: false }], "general")).toThrow();
  });
});

describe("daily card", () => {
  it("is stable per device, day and topic, and differs across devices", () => {
    const a = dailyCard("device-a", "2026-10-24", "general", true);
    expect(dailyCard("device-a", "2026-10-24", "general", true)).toEqual(a);
    const others = ["device-b", "device-c", "device-d", "device-e"].map((d) => dailyCard(d, "2026-10-24", "general", true).id);
    expect(others.some((id) => id !== a.id)).toBe(true);
  });
  it("never reverses when reversals are off", () => {
    for (let i = 0; i < 50; i++) expect(dailyCard(`d${i}`, "2026-10-24", "love", false).reversed).toBe(false);
  });
});
