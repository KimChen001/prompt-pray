import { describe, expect, it } from "vitest";
import { allEntries, getEntry, learnHref, LEARN_TYPES, RULES, searchLearn, SIGN_CONTENT, PLANET_CONTENT, HOUSE_CONTENT, ASPECT_CONTENT, SPREAD_CONTENT } from "@/lib/learn";
import { SIGNS, PLANETS } from "@/lib/astro/zodiac";
import { NATAL_RULES } from "@/lib/astro/natal-facts";

const ids = (q: string, type?: Parameters<typeof searchLearn>[1]) => searchLearn(q, type).map((e) => `${e.type}/${e.slug}`);

describe("Learn index", () => {
  it("has every sign, planet, house, aspect, card and spread exactly once", () => {
    const all = allEntries();
    const count = (t: string) => all.filter((e) => e.type === t).length;
    expect([count("sign"), count("planet"), count("house"), count("aspect"), count("card"), count("spread")]).toEqual([12, 10, 12, 5, 78, 4]);
    const keys = all.map((e) => `${e.type}/${e.slug}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of all) {
      expect(e.title.en.trim(), `${e.type}/${e.slug}`).not.toBe("");
      expect(e.title.zh.trim(), `${e.type}/${e.slug}`).not.toBe("");
      expect(e.subtitle.en.trim(), `${e.type}/${e.slug}`).not.toBe("");
      expect(e.subtitle.zh.trim(), `${e.type}/${e.slug}`).not.toBe("");
      expect(getEntry(e.type, e.slug)).toBe(e);
      expect(learnHref(e.type, e.slug)).toBe(`/learn/${e.type}/${e.slug}`);
    }
    expect(getEntry("sign", "ophiuchus")).toBeNull();
    expect(getEntry("nope", "aries")).toBeNull();
    expect(LEARN_TYPES).toHaveLength(6);
  });

  it("content ids line up with the app's own ids", () => {
    expect(SIGN_CONTENT.map((c) => c.id)).toEqual(SIGNS);
    expect(PLANET_CONTENT.map((c) => c.id)).toEqual(PLANETS);
    expect(HOUSE_CONTENT.map((c) => c.id)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(ASPECT_CONTENT.map((c) => c.id).sort()).toEqual(Object.keys(NATAL_RULES.orbs).sort());
    expect(SPREAD_CONTENT.map((c) => c.id)).toEqual(["single", "triad", "relate", "choice"]);
    for (const c of ASPECT_CONTENT) expect([0, 60, 90, 120, 180]).toContain(c.angle);
  });

  it("derives rulerships from the same table as the chart ruler", () => {
    expect(RULES.venus).toEqual(["taurus", "libra"]);
    expect(RULES.mercury).toEqual(["gemini", "virgo"]);
    expect(RULES.pluto).toEqual(["scorpio"]);
    expect(Object.values(RULES).flat().sort()).toEqual([...SIGNS].sort()); // every sign has exactly one modern ruler
  });
});

describe("Learn search", () => {
  it("finds the Moon in English and Chinese (plan acceptance test)", () => {
    for (const q of ["moon", "Moon", "月亮", "ｍｏｏｎ"]) {
      const r = ids(q);
      expect(r[0], q).toBe("planet/moon");
      expect(r, q).toContain("card/major-18");
    }
  });
  it("ranks names first and understands aliases", () => {
    expect(ids("scorpio")[0]).toBe("sign/scorpio");
    expect(ids("天蝎")[0]).toBe("sign/scorpio");
    expect(ids("rising")[0]).toBe("house/1");
    expect(ids("上升")[0]).toBe("house/1");
    expect(ids("midheaven")[0]).toBe("house/10");
    expect(ids("水逆")[0]).toBe("planet/mercury");
    expect(ids("tower")[0]).toBe("card/major-16");
    expect(ids("高塔")[0]).toBe("card/major-16");
    expect(ids("7th house")[0]).toBe("house/7");
    expect(ids("抉择")[0]).toBe("spread/choice");
  });
  it("filters by type and ignores too-short or unknown queries", () => {
    expect(ids("moon", "card").every((x) => x.startsWith("card/"))).toBe(true);
    expect(ids("moon", "planet")).toEqual(["planet/moon"]);
    expect(ids("m")).toEqual([]);
    expect(ids("   ")).toEqual([]);
    expect(ids("月").length).toBeGreaterThan(0); // one Chinese character is a real word
    expect(ids("xyzzy")).toEqual([]);
  });
});
