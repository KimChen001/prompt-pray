// Learn (plan v0.2 §3.6): one index over signs, planets, houses, aspects, tarot cards and spreads,
// with stable ids shared by every page that links here. Search runs in the browser; with ~120 entries
// a scored substring match is enough and handles Chinese without a word segmenter.
import type { CardData, Element, L10n, SpreadId } from "@/lib/tarot/types";
import { DECK } from "@/lib/tarot/deck";
import { SPREADS } from "@/lib/tarot/spreads";
import { PLANETS, PLANET_NAME, SIGNS, SIGN_INFO, type Modality, type Planet, type Sign } from "@/lib/astro/zodiac";
import { HOUSE_THEME } from "@/lib/astro/horoscope";
import { ASPECT_NAME, ELEMENT_NAME, MODALITY_NAME, houseName } from "@/lib/astro/labels";
import { NATAL_RULES } from "@/lib/astro/natal-facts";
import { SIGN_KEYWORDS, PLANET_FUNCTION } from "@/lib/astro/natal-text";
import type { Aspect } from "@/lib/astro/transits";
import signsJson from "../../../content/learn/signs.json";
import planetsJson from "../../../content/learn/planets.json";
import housesJson from "../../../content/learn/houses.json";
import aspectsJson from "../../../content/learn/aspects.json";
import spreadsJson from "../../../content/learn/spreads.json";
import en from "@/lib/i18n/en";
import zh from "@/lib/i18n/zh";

export const LEARN_TYPES = ["sign", "planet", "house", "aspect", "card", "spread"] as const;
export type LearnType = (typeof LEARN_TYPES)[number];
export const isLearnType = (v: unknown): v is LearnType => LEARN_TYPES.includes(v as LearnType);

export interface SignContent { id: Sign; dates: L10n; summary: L10n; strengths: L10n; growth: L10n }
export interface PlanetContent { id: Planet; glyph: string; pace: L10n; summary: L10n }
export interface HouseContent { id: number; summary: L10n }
export interface AspectContent { id: Aspect; glyph: string; angle: number; summary: L10n }
export interface SpreadContent { id: SpreadId; howTo: L10n }

export const SIGN_CONTENT = signsJson as SignContent[];
export const PLANET_CONTENT = planetsJson as PlanetContent[];
export const HOUSE_CONTENT = housesJson as HouseContent[];
export const ASPECT_CONTENT = aspectsJson as AspectContent[];
export const SPREAD_CONTENT = spreadsJson as SpreadContent[];

/** Signs each planet rules (modern rulerships, as used for the chart ruler). */
export const RULES: Record<Planet, Sign[]> = Object.fromEntries(
  PLANETS.map((p) => [p, SIGNS.filter((s) => NATAL_RULES.rulers[s] === p)]),
) as Record<Planet, Sign[]>;
/** Traditional rulers shown alongside the modern ones. */
export const TRADITIONAL_RULER: Partial<Record<Sign, Planet>> = { scorpio: "mars", aquarius: "saturn", pisces: "jupiter" };

export const SUIT_NAME: Record<NonNullable<CardData["suit"]>, L10n> = {
  wands: { en: "Wands", zh: "权杖" },
  cups: { en: "Cups", zh: "圣杯" },
  swords: { en: "Swords", zh: "宝剑" },
  pentacles: { en: "Pentacles", zh: "星币" },
};

/** Extra search terms that aren't in an entry's own text. */
const ALIASES: Record<string, string[]> = {
  "planet/moon": ["luna", "月"],
  "planet/mercury": ["mercury retrograde", "水逆"],
  "house/1": ["ascendant", "rising", "asc", "上升", "上升点"],
  "house/4": ["ic", "imum coeli", "天底"],
  "house/7": ["descendant", "dsc", "下降点"],
  "house/10": ["midheaven", "mc", "天顶"],
  "aspect/conjunction": ["conjunct"],
  "aspect/opposition": ["opposite"],
};

export interface LearnEntry {
  type: LearnType;
  slug: string;
  title: L10n;
  subtitle: L10n;
  glyph?: string;
  /** Lower-cased names (both languages) and aliases: matched first. */
  names: string[];
  /** Keywords and body text in both languages: matched with lower weight. */
  text: string;
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const both = (l: L10n) => [l.en, l.zh];
const join = (...parts: (L10n | string)[]): L10n => ({
  en: parts.map((p) => (typeof p === "string" ? p : p.en)).join(""),
  zh: parts.map((p) => (typeof p === "string" ? p : p.zh)).join(""),
});

function build(): LearnEntry[] {
  const out: LearnEntry[] = [];
  const add = (type: LearnType, slug: string, title: L10n, subtitle: L10n, texts: string[], glyph?: string) =>
    out.push({ type, slug, title, subtitle, glyph, names: [...both(title), ...(ALIASES[`${type}/${slug}`] ?? [])].map(norm), text: norm(texts.join(" \n ")) });

  for (const c of SIGN_CONTENT) {
    const info = SIGN_INFO[c.id];
    add("sign", c.id, info.name, join(ELEMENT_NAME[info.element], " · ", MODALITY_NAME[info.modality], " · ", c.dates), [
      ...both(SIGN_KEYWORDS[c.id]), ...both(c.summary), ...both(c.strengths), ...both(c.growth), ...both(ELEMENT_NAME[info.element]),
    ], info.glyph);
  }
  for (const c of PLANET_CONTENT) {
    add("planet", c.id, PLANET_NAME[c.id], c.pace, [...both(PLANET_FUNCTION[c.id]), ...both(c.summary)], c.glyph);
  }
  for (const c of HOUSE_CONTENT) {
    add("house", String(c.id), houseName(c.id), HOUSE_THEME[c.id - 1], [...both(HOUSE_THEME[c.id - 1]), ...both(c.summary)]);
  }
  for (const c of ASPECT_CONTENT) {
    add("aspect", c.id, { en: cap(ASPECT_NAME[c.id].en === "conjunct" ? "conjunction" : ASPECT_NAME[c.id].en === "opposite" ? "opposition" : ASPECT_NAME[c.id].en), zh: ASPECT_NAME[c.id].zh }, { en: `${c.angle}°`, zh: `${c.angle}°` }, both(c.summary), c.glyph);
  }
  for (const card of DECK) {
    const sub: L10n = card.arcana === "major" ? { en: "Major Arcana", zh: "大阿尔卡那" } : join(SUIT_NAME[card.suit!], { en: " · Minor Arcana", zh: " · 小阿尔卡那" });
    add("card", card.id, card.name, sub, [
      ...card.upright.keywords.en, ...card.upright.keywords.zh, ...card.reversed.keywords.en, ...card.reversed.keywords.zh,
      ...both(card.upright.meaning), ...both(card.description),
    ]);
  }
  for (const c of SPREAD_CONTENT) {
    const s = SPREADS[c.id];
    add("spread", c.id, { en: en.spreads[c.id].name, zh: zh.spreads[c.id].name }, { en: `${s.count} card${s.count > 1 ? "s" : ""}`, zh: `${s.count} 张牌` }, [
      ...both(c.howTo), en.spreads[c.id].desc, zh.spreads[c.id].desc, ...s.positions.flatMap(both),
    ]);
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

let cache: LearnEntry[] | null = null;
export function allEntries(): LearnEntry[] {
  return (cache ??= build());
}

export function getEntry(type: string, slug: string): LearnEntry | null {
  return allEntries().find((e) => e.type === type && e.slug === slug) ?? null;
}

export const learnHref = (type: LearnType, slug: string | number) => `/learn/${type}/${slug}`;

/**
 * Scored search over names (exact > prefix > contains) and then keywords/body text, in both
 * languages at once. Latin queries need 2+ characters; a single CJK character is allowed.
 */
export function searchLearn(query: string, type?: LearnType): LearnEntry[] {
  const q = norm(query);
  if (!q || (q.length < 2 && !/\p{Script=Han}/u.test(q))) return [];
  const scored: { e: LearnEntry; score: number }[] = [];
  for (const e of allEntries()) {
    if (type && e.type !== type) continue;
    let score = 0;
    for (const n of e.names) {
      if (n === q) score = Math.max(score, 100);
      else if (n.startsWith(q) || n.replace(/^the /, "").startsWith(q)) score = Math.max(score, 80);
      else if (n.includes(q)) score = Math.max(score, 60);
    }
    if (!score && e.text.includes(q)) score = 20;
    if (score) scored.push({ e, score });
  }
  const order = (t: LearnType) => LEARN_TYPES.indexOf(t);
  return scored.sort((a, b) => b.score - a.score || order(a.e.type) - order(b.e.type)).map((s) => s.e);
}

export type { Element, Modality };
