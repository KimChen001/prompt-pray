import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fixtures from "./fixtures/charts.sweph.json";
import { computeChart } from "@/lib/astro/chart";
import { natalFacts, type NatalFact } from "@/lib/astro/natal-facts";
import { selectThemes } from "@/lib/astro/natal-themes";
import { themeLibraryText } from "@/lib/astro/natal-text";
import { chartFingerprint, keyString, natalRequestBody, natalVersionKey, sameChart, toSavedReport } from "@/lib/astro/natal-report";
import { SIGN_INFO, SIGNS, PLANET_NAME, type Planet, type Sign } from "@/lib/astro/zodiac";
import type { BirthData } from "@/lib/astro/birth";
import { inconsistentClaim, NATAL_PROMPT_VERSION, natalPrompt, parseNatalRequest, validateNatal } from "@/lib/ai/natal-prompt";
import { resetAiLimits } from "@/lib/ai/guard";
import { POST as natalPOST } from "@/app/api/ai/natal/route";

afterEach(() => {
  resetAiLimits();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function fixtureBirth(c: (typeof fixtures.charts)[number], withTime = true): BirthData {
  return { date: c.utc.slice(0, 10), time: withTime ? c.utc.slice(11, 16) : null, place: { name: c.id, country: "", lat: c.lat, lon: c.lon, tz: "UTC" } };
}
function setup(c: (typeof fixtures.charts)[number], withTime = true, locale: "en" | "zh" = "en") {
  const birth = fixtureBirth(c, withTime);
  const chart = computeChart(birth);
  const nf = natalFacts(birth, chart);
  const sel = selectThemes(nf);
  const body = natalRequestBody(nf, sel, locale);
  const req = parseNatalRequest(JSON.parse(JSON.stringify(body)))!;
  return { birth, chart, nf, sel, body, req };
}
/** A model reply built from our own library text — it must always pass the validator. */
function libraryReply(s: ReturnType<typeof setup>, locale: "en" | "zh" = "en") {
  return {
    themes: s.sel.themes.map((t) => ({ id: t.id, text: themeLibraryText(t, s.nf.byId)[locale], evidenceIds: t.evidenceIds.slice(0, 2) })),
    overview: locale === "en" ? "These themes may work together in everyday choices." : "这些主题可能在日常选择中相互配合。",
  };
}
const placements = (facts: NatalFact[]) => facts.filter((f): f is Extract<NatalFact, { kind: "placement" }> => f.kind === "placement");
const otherSign = (s: Sign): Sign => SIGNS[(SIGNS.indexOf(s) + 5) % 12];

describe.each(fixtures.charts)("natal AI request for $label", (c) => {
  for (const withTime of [true, false]) {
    describe(withTime ? "time known" : "time unknown", () => {
      const s = setup(c, withTime);

      it("parses the browser's body and sends no birth data", () => {
        expect(s.req).not.toBeNull();
        const json = JSON.stringify(s.body);
        expect(json).not.toContain(s.birth.date);
        expect(json).not.toContain(String(s.birth.place.lat));
        expect(json).not.toContain(c.id);
        const prompt = natalPrompt(s.req);
        for (const t of s.sel.themes) expect(prompt.user).toContain(t.id);
        expect(prompt.user).not.toContain(s.birth.date);
        if (!withTime) expect(prompt.system).toContain("birth time is unknown");
      });

      it("accepts our own library text in both languages", () => {
        expect(validateNatal(libraryReply(s), s.req)).not.toBeNull();
        const zh = setup(c, withTime, "zh");
        expect(validateNatal(libraryReply(zh, "zh"), zh.req)).not.toBeNull();
      });

      it("rejects a wrong sign for any placement, cited or not", () => {
        const cited = new Set(s.sel.themes.flatMap((t) => t.evidenceIds));
        const all = placements(s.req.facts);
        expect(all.length + s.req.facts.filter((f) => f.kind === "uncertainPlacement").length).toBe(10);
        const uncited = all.find((f) => !cited.has(f.id));
        for (const p of [all[0], uncited].filter((x) => x !== undefined)) {
          const reply = libraryReply(s);
          reply.themes[0].text += ` Your ${PLANET_NAME[p.body].en} in ${SIGN_INFO[otherSign(p.sign)].name.en} adds intensity.`;
          expect(validateNatal(reply, s.req)).toBeNull();
          expect(validateNatal({ ...libraryReply(s), overview: `${SIGN_INFO[otherSign(p.sign)].name.en} ${PLANET_NAME[p.body].en} energy.` }, s.req)).toBeNull();
        }
      });

      it("rejects evidence ids from outside the theme", () => {
        const reply = libraryReply(s);
        const foreign = s.nf.facts.find((f) => !s.sel.themes[0].evidenceIds.includes(f.id))!;
        reply.themes[0].evidenceIds = [foreign.id];
        expect(validateNatal(reply, s.req)).toBeNull();
      });
    });
  }
});

describe("natal validation rules", () => {
  const known = setup(fixtures.charts[0], true);
  const unknown = setup(fixtures.charts[0], false);
  const reply = (s: ReturnType<typeof setup>, extra: string, locale: "en" | "zh" = "en") => {
    const r = libraryReply(s, locale);
    r.themes[0].text += extra;
    return r;
  };

  it("requires every theme exactly once and non-empty evidence", () => {
    const r = libraryReply(known);
    expect(validateNatal({ ...r, themes: r.themes.slice(1) }, known.req)).toBeNull();
    expect(validateNatal({ ...r, themes: [r.themes[0], ...r.themes.slice(0, -1)] }, known.req)).toBeNull();
    expect(validateNatal({ ...r, themes: [{ ...r.themes[0], evidenceIds: [] }, ...r.themes.slice(1)] }, known.req)).toBeNull();
    expect(validateNatal({ ...r, overview: "" }, known.req)).toBeNull();
    // order is normalized to the request order
    const reversed = validateNatal({ ...r, themes: [...r.themes].reverse() }, known.req)!;
    expect(reversed.themes.map((t) => t.id)).toEqual(known.sel.themes.map((t) => t.id));
  });

  it("checks Rising and houses against the birth time", () => {
    const asc = known.nf.facts.find((f) => f.kind === "angle" && f.body === "asc") as Extract<NatalFact, { kind: "angle" }>;
    const right = SIGN_INFO[asc.sign].name, wrong = SIGN_INFO[otherSign(asc.sign)].name;
    expect(inconsistentClaim(`With ${right.en} Rising, first impressions matter.`, known.req)).toBeNull();
    expect(inconsistentClaim(`With ${wrong.en} Rising, first impressions matter.`, known.req)).not.toBeNull();
    expect(inconsistentClaim(`Your Ascendant is in ${wrong.en}.`, known.req)).not.toBeNull();
    expect(inconsistentClaim(`${wrong.zh}上升让你显得从容。`, known.req)).not.toBeNull();
    expect(inconsistentClaim(`上升星座是${right.zh}。`, known.req)).toBeNull();
    // unknown time: may say it needs a birth time, may not name a Rising sign or a house
    expect(inconsistentClaim("Your Rising sign needs a birth time.", unknown.req)).toBeNull();
    expect(inconsistentClaim(`With ${right.en} Rising, first impressions matter.`, unknown.req)).not.toBeNull();
    expect(inconsistentClaim("This energy lives in your 7th house.", unknown.req)).not.toBeNull();
    expect(inconsistentClaim("这股能量在第 7 宫。", unknown.req)).not.toBeNull();
  });

  it("checks planet houses and aspects against the facts", () => {
    const p = placements(known.req.facts).find((f) => f.house)!;
    const name = PLANET_NAME[p.body];
    const wrongHouse = (p.house! % 12) + 1;
    expect(inconsistentClaim(`${name.en} in your ${p.house}${p.house === 1 ? "st" : p.house === 2 ? "nd" : p.house === 3 ? "rd" : "th"} house`, known.req)).toBeNull();
    expect(inconsistentClaim(`${name.en} sits in the ${wrongHouse}${wrongHouse === 1 ? "st" : wrongHouse === 2 ? "nd" : wrongHouse === 3 ? "rd" : "th"} house`, known.req)).not.toBeNull();
    expect(inconsistentClaim(`${name.zh}在第 ${wrongHouse} 宫`, known.req)).not.toBeNull();

    const asp = known.req.facts.find((f) => f.kind === "aspect") as Extract<NatalFact, { kind: "aspect" }> | undefined;
    if (asp) {
      const a = PLANET_NAME[asp.a], b = PLANET_NAME[asp.b];
      const wrong = asp.aspect === "trine" ? "squares" : "trines";
      const wrongZh = asp.aspect === "trine" ? "四分相" : "三分相";
      expect(inconsistentClaim(`${a.en} ${wrong} ${b.en}`, known.req)).not.toBeNull();
      expect(inconsistentClaim(`${a.zh}与${b.zh}形成${wrongZh}`, known.req)).not.toBeNull();
    }
    expect(inconsistentClaim("Mars trines Pluto", { ...known.req, facts: known.req.facts.filter((f) => f.kind !== "aspect") })).not.toBeNull();
  });

  it("names an uncertain Sun or Moon only together with its other sign", () => {
    const u = fixtures.charts.map((c) => setup(c, false)).find((s) => s.req.facts.some((f) => f.kind === "uncertainPlacement"));
    // Synthetic request when no fixture's Moon changes sign that day.
    const req = u?.req ?? {
      ...unknown.req,
      facts: [...unknown.req.facts.filter((f) => !(f.kind === "placement" && f.body === "moon")), { id: "place.moon", kind: "uncertainPlacement" as const, timeIndependent: true, body: "moon" as const, options: ["gemini", "cancer"] as [Sign, Sign], changesAt: "14:05" }],
    };
    const f = req.facts.find((x) => x.kind === "uncertainPlacement") as Extract<NatalFact, { kind: "uncertainPlacement" }>;
    const [a, b] = f.options.map((s) => SIGN_INFO[s].name);
    const body = PLANET_NAME[f.body as Planet];
    expect(inconsistentClaim(`${body.en} in ${a.en} or ${b.en}`, req)).toBeNull();
    expect(inconsistentClaim(`${body.en} in ${a.en} makes you careful.`, req)).not.toBeNull();
    expect(inconsistentClaim(`${body.zh}在${a.zh}或${b.zh}`, req)).toBeNull();
  });

  it("rejects quoted degrees and crisis language", () => {
    expect(validateNatal(reply(known, " It sits at 14°."), known.req)).toBeNull();
    expect(validateNatal(reply(known, " Some days you may want to die."), known.req)).toBeNull();
    expect(validateNatal(reply(known, " 有时你会不想活了。", "zh"), setup(fixtures.charts[0], true, "zh").req)).toBeNull();
  });

  it("rejects tampered requests", () => {
    const b = known.body;
    expect(parseNatalRequest({ ...b, locale: "fr" })).toBeNull();
    expect(parseNatalRequest({ ...b, themes: [] })).toBeNull();
    expect(parseNatalRequest({ ...b, themes: [b.themes[0], b.themes[0]] })).toBeNull();
    expect(parseNatalRequest({ ...b, themes: [{ ...b.themes[0], evidenceIds: ["place.nowhere"] }] })).toBeNull();
    expect(parseNatalRequest({ ...b, facts: [...b.facts, { id: "x", kind: "made-up", timeIndependent: true }] })).toBeNull();
    expect(parseNatalRequest({ ...b, facts: [...b.facts, b.facts[0]] })).toBeNull();
    // time-dependent facts with "time unknown" are inconsistent
    expect(parseNatalRequest({ ...b, timeKnown: false })).toBeNull();
  });
});

describe("natal report versions", () => {
  const c = fixtures.charts[0];
  const a = setup(c, true);
  const key = natalVersionKey(a.nf, a.sel, "placidus", NATAL_PROMPT_VERSION, "en");

  it("fingerprints the facts, not the request", () => {
    expect(chartFingerprint(a.nf)).toBe(chartFingerprint(setup(c, true).nf));
    expect(chartFingerprint(a.nf)).not.toBe(chartFingerprint(setup(c, false).nf));
    const whole = natalFacts(a.birth, computeChart(a.birth, "whole"));
    const wholeKey = natalVersionKey(whole, selectThemes(whole), "whole", NATAL_PROMPT_VERSION, "en");
    expect(keyString(wholeKey)).not.toBe(keyString(key));
  });

  it("separates language and prompt/rule versions; sameChart ignores versions only", () => {
    const zh = { ...key, locale: "zh" as const };
    const newer = { ...key, promptVersion: "natal-report@2" };
    expect(keyString(zh)).not.toBe(keyString(key));
    expect(keyString(newer)).not.toBe(keyString(key));
    expect(sameChart(newer, key)).toBe(true);
    expect(sameChart({ ...key, themesVersion: "natal-themes@9" }, key)).toBe(true);
    expect(sameChart(zh, key)).toBe(false);
    expect(sameChart({ ...key, fingerprint: "00000000" }, key)).toBe(false);
    // without a birth time the house system cannot matter
    const u = setup(c, false);
    expect(keyString(natalVersionKey(u.nf, u.sel, "whole", NATAL_PROMPT_VERSION, "en"))).toBe(keyString(natalVersionKey(u.nf, u.sel, "placidus", NATAL_PROMPT_VERSION, "en")));
  });

  it("freezes titles, evidence labels and limitations into the saved version", () => {
    const res = { ...libraryReply(a), promptVersion: NATAL_PROMPT_VERSION, meta: { provider: "mock", model: "m", generatedAt: "2026-10-09T12:00:00.000Z" } };
    const saved = toSavedReport(key, a.nf, a.sel, res);
    expect(saved.createdAt).toBe(res.meta.generatedAt);
    expect(saved.themes).toHaveLength(a.sel.themes.length);
    for (const t of saved.themes) {
      expect(t.evidence.length).toBeGreaterThan(0);
      for (const e of t.evidence) expect(e.label.en.length).toBeGreaterThan(3);
      expect(t.title).toEqual(a.sel.themes.find((s) => s.id === t.id)!.title);
    }
  });
  it("recognizes a saved v1 unknown-time report after the orb-rule upgrade", () => {
    const unknown = setup(c, false);
    const current = natalVersionKey(unknown.nf, unknown.sel, "placidus", NATAL_PROMPT_VERSION, "en");
    const legacy = { ...current, fingerprint: chartFingerprint({ ...unknown.nf, facts: unknown.nf.legacyFacts! }), factsVersion: "natal-facts@1", themesVersion: "natal-themes@1", textVersion: "natal-text@1", previousFingerprints: undefined };
    expect(legacy.fingerprint).toBe("b90c878a"); // independently computed from the v1 Git source, Boston fixture
    expect(keyString(legacy)).not.toBe(keyString(current));
    expect(sameChart(legacy, current)).toBe(true); // component keeps this report and offers a manual update
    expect(sameChart(current, legacy)).toBe(true);
    expect(sameChart({ ...legacy, locale: "zh" }, current)).toBe(false);
    expect(natalRequestBody(unknown.nf, unknown.sel, "en")).not.toHaveProperty("legacyFacts");
  });
});

describe("natal route (mocked provider)", () => {
  const s = setup(fixtures.charts[0], true);
  const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 600 } }), { status: 200 });
  const post = (body: unknown) => new NextRequest("http://localhost/api/ai/natal", { method: "POST", body: JSON.stringify(body) });
  beforeEach(() => {
    vi.stubEnv("AI_USAGE_FILE", join(mkdtempSync(join(tmpdir(), "moona-ai-")), "u.json"));
    vi.stubEnv("AI_API_KEY", "k");
  });

  it("returns validated themes with the prompt version and metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(JSON.stringify(libraryReply(s))));
    vi.stubGlobal("fetch", fetchMock);
    const res = await natalPOST(post(s.body));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.promptVersion).toBe(NATAL_PROMPT_VERSION);
    expect(json.themes.map((t: { id: string }) => t.id)).toEqual(s.sel.themes.map((t) => t.id));
    expect(json.meta.generatedAt).toBeTruthy();
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(JSON.stringify(sent)).not.toContain(s.birth.date);
  });

  it("502 when the model contradicts a placement", async () => {
    const bad = libraryReply(s);
    const p = placements(s.req.facts)[0];
    bad.overview = `${PLANET_NAME[p.body].en} in ${SIGN_INFO[otherSign(p.sign)].name.en} ties it together.`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(JSON.stringify(bad))));
    const res = await natalPOST(post(s.body));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: "bad_output" });
  });

  it("400 on a malformed body and 503 when unconfigured, without calling the model", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await natalPOST(post({ ...s.body, themes: "x" }))).status).toBe(400);
    vi.stubEnv("AI_API_KEY", "");
    expect((await natalPOST(post(s.body))).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
