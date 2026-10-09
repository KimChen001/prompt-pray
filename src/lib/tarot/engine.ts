// Offline reading engine. Ported from the mini-program's utils/tarotPro.js and rewritten
// to produce bilingual, user-facing text. Deterministic: same input → same output.
import { elementOf, getCard } from "./deck";
import { SPREADS } from "./spreads";
import type { CardData, CardSide, DrawnCard, Element, L10n, L10nList, SpreadId, Topic } from "./types";

type Lookup = (id: string) => CardData;

export interface CardInsight {
  id: string;
  reversed: boolean;
  position: L10n;
  name: L10n;
  keywords: L10nList;
  /** One-line card message shown before the full reading (first sentence of the reviewed meaning). */
  phrase: L10n;
  meaning: L10n;
  topicLine: L10n | null;
  advice: L10n;
}

export type Pattern = "allReversed" | "mostlyReversed" | "manyMajors" | "noMajors" | "sameSuit" | "repeatedNumber";

export interface ChoiceResult {
  scoreA: number;
  scoreB: number;
  verdict: "A" | "B" | "close";
}

export interface Analysis {
  perCard: CardInsight[];
  /** Offline reflection question for the topic. */
  reflection: L10n;
  elementCounts: Record<Element, number>;
  dominant: Element | null;
  patterns: Pattern[];
  choice: ChoiceResult | null;
  summary: L10n;
  action: L10n;
}

// ---------- scoring (spec: MOONA网页版方案v0.2 §3.2) ----------

/** Suits that speak most directly to a topic; used for the +0.4 relevance bonus. */
const TOPIC_SUITS: Record<Topic, Array<CardData["suit"] | "major">> = {
  general: [],
  love: ["cups"],
  work: ["pentacles", "wands"],
  growth: ["swords", "major"],
};

export function cardWeight(card: CardData, reversed: boolean, topic: Topic): number {
  let w = card.arcana === "major" ? 3 : 1;
  if (reversed) w *= 0.7;
  const key = card.arcana === "major" ? "major" : card.suit;
  if (TOPIC_SUITS[topic].includes(key)) w += 0.4;
  return w;
}

const SUPPORT: Record<string, number> = {
  "fire-air": 1, "air-fire": 1, "water-earth": 1, "earth-water": 1,
  "fire-water": -1, "water-fire": -1, "air-earth": -1, "earth-air": -1,
};

/** Elemental affinity: same element +0.5, supportive +1, opposing −1, other pairs −0.5, Major Arcana 0. */
export function affinity(a: Element | null, b: Element | null): number {
  if (!a || !b) return 0;
  if (a === b) return 0.5;
  return SUPPORT[`${a}-${b}`] ?? -0.5;
}

export function scoreChoice(cards: Array<{ card: CardData; reversed: boolean }>, topic: Topic): ChoiceResult {
  const [a, b, key, outcome] = cards;
  const side = (opt: typeof a) =>
    cardWeight(opt.card, opt.reversed, topic) +
    0.5 * affinity(elementOf(key.card), elementOf(opt.card)) +
    0.5 * affinity(elementOf(outcome.card), elementOf(opt.card));
  const scoreA = round1(side(a));
  const scoreB = round1(side(b));
  const verdict = Math.abs(scoreA - scoreB) < 0.5 ? "close" : scoreA > scoreB ? "A" : "B";
  return { scoreA, scoreB, verdict };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------- patterns ----------

export function findPatterns(cards: Array<{ card: CardData; reversed: boolean }>): Pattern[] {
  const out: Pattern[] = [];
  const n = cards.length;
  const reversed = cards.filter((c) => c.reversed).length;
  const majors = cards.filter((c) => c.card.arcana === "major").length;
  if (n > 1 && reversed === n) out.push("allReversed");
  else if (n > 2 && reversed >= Math.ceil(n / 2)) out.push("mostlyReversed");
  if (n > 1 && majors >= Math.ceil(n * 0.66)) out.push("manyMajors");
  if (n >= 3 && majors === 0) out.push("noMajors");
  const suits = countBy(cards.map((c) => c.card.suit).filter(Boolean) as string[]);
  if (Object.values(suits).some((v) => v >= 2)) out.push("sameSuit");
  const numbers = countBy(cards.filter((c) => c.card.arcana === "minor").map((c) => String(c.card.number)));
  if (Object.values(numbers).some((v) => v >= 2)) out.push("repeatedNumber");
  return out;
}

function countBy(items: string[]): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, k) => ((acc[k] = (acc[k] ?? 0) + 1), acc), {});
}

// ---------- text ----------

const ELEMENT_NAME: Record<Element, L10n> = {
  fire: { en: "Fire", zh: "火" },
  water: { en: "Water", zh: "水" },
  air: { en: "Air", zh: "风" },
  earth: { en: "Earth", zh: "土" },
};
const ELEMENT_THEME: Record<Element, L10n> = {
  fire: { en: "drive and momentum", zh: "行动与冲劲" },
  water: { en: "feelings and connection", zh: "情感与连结" },
  air: { en: "thoughts and conversations", zh: "思考与沟通" },
  earth: { en: "work, body and resources", zh: "现实、身体与资源" },
};

const PATTERN_TEXT: Record<Pattern, L10n> = {
  allReversed: {
    en: "Every card is reversed: the energy here is stuck or turned inward, so start by clearing what is in the way.",
    zh: "所有牌都是逆位：能量受阻或向内收，先清掉挡在路上的东西。",
  },
  mostlyReversed: {
    en: "Several cards are reversed, so expect some delay; be patient with the timing.",
    zh: "逆位牌偏多，事情可能会慢一些，对节奏多一点耐心。",
  },
  manyMajors: {
    en: "Most of these are Major Arcana — this is about a bigger chapter, not just this week.",
    zh: "大阿卡纳占了多数——这关乎人生的一个大篇章，而不只是这一周。",
  },
  noMajors: {
    en: "No Major Arcana appear, so this is practical and largely within your hands day to day.",
    zh: "没有出现大阿卡纳，这件事偏日常、务实，主动权大多在你手里。",
  },
  sameSuit: {
    en: "Cards of the same suit repeat, which turns up the volume on that theme.",
    zh: "同一花色重复出现，这个主题被放大了。",
  },
  repeatedNumber: {
    en: "A number repeats across the minor cards — notice where the same lesson keeps returning.",
    zh: "小阿卡纳中出现了重复的数字——留意同一个课题在哪里反复出现。",
  },
};

const rev = (r: boolean): L10n => (r ? { en: " (reversed)", zh: "（逆位）" } : { en: "", zh: "" });
const named = (c: { card: CardData; reversed: boolean }): L10n => ({
  en: c.card.name.en + rev(c.reversed).en,
  zh: c.card.name.zh + rev(c.reversed).zh,
});

function opening(spread: SpreadId, cs: Array<{ card: CardData; reversed: boolean }>): L10n {
  const n = cs.map(named);
  switch (spread) {
    case "single": {
      const kw = sideOf(cs[0].card, cs[0].reversed).keywords;
      return {
        en: `${n[0].en} is your card — ${kw.en.slice(0, 3).join(", ").toLowerCase()}.`,
        zh: `你抽到的是${n[0].zh}——${kw.zh.slice(0, 3).join("、")}。`,
      };
    }
    case "triad":
      return {
        en: `Your story moves from ${n[0].en}, through ${n[1].en}, toward ${n[2].en}.`,
        zh: `你的故事从${n[0].zh}出发，经过${n[1].zh}，走向${n[2].zh}。`,
      };
    case "relate":
      return {
        en: `You show up as ${n[0].en}, they show up as ${n[1].en}, and what sits between you is ${n[2].en}.`,
        zh: `你呈现为${n[0].zh}，对方呈现为${n[1].zh}，你们之间是${n[2].zh}。`,
      };
    case "choice":
      return {
        en: `Option A draws ${n[0].en}; Option B draws ${n[1].en}.`,
        zh: `选项 A 抽到${n[0].zh}，选项 B 抽到${n[1].zh}。`,
      };
  }
}

function elementSentence(counts: Record<Element, number>, total: number): { text: L10n | null; dominant: Element | null } {
  const ranked = (Object.keys(counts) as Element[]).filter((e) => counts[e] > 0).sort((a, b) => counts[b] - counts[a]);
  if (!ranked.length || total < 2) return { text: null, dominant: ranked[0] ?? null };
  const dom = ranked[0];
  const second = ranked[1];
  let en = `${ELEMENT_NAME[dom].en} leads this spread (${counts[dom]} of ${total}) — ${ELEMENT_THEME[dom].en}.`;
  let zh = `这组牌以${ELEMENT_NAME[dom].zh}元素为主（${counts[dom]}/${total} 张）——${ELEMENT_THEME[dom].zh}。`;
  if (second) {
    const a = affinity(dom, second);
    const rel: L10n =
      a > 0
        ? { en: "supports", zh: "相互支持" }
        : a < -0.5
          ? { en: "pushes against", zh: "彼此牵制" }
          : { en: "sits in tension with", zh: "形成张力" };
    en += ` It ${rel.en} ${ELEMENT_NAME[second].en.toLowerCase()} (${ELEMENT_THEME[second].en}).`;
    zh += `它与${ELEMENT_NAME[second].zh}元素（${ELEMENT_THEME[second].zh}）${rel.zh}。`;
  }
  return { text: { en, zh }, dominant: dom };
}

function choiceSentence(r: ChoiceResult): L10n {
  const scores = `${r.scoreA} vs ${r.scoreB}`;
  if (r.verdict === "close")
    return {
      en: `It is too close to call (${scores}) — let the Key factor card tell you what matters most.`,
      zh: `两边非常接近（${scores}）——让“关键因素”那张牌告诉你什么最重要。`,
    };
  const w = r.verdict;
  return {
    en: `On balance, Option ${w} has more support (${scores}): its card carries more weight and the Key factor and Outcome lean its way.`,
    zh: `综合来看，选项 ${w} 的支持更多（${scores}）：它的牌分量更重，“关键因素”和“走向”也更偏向它。`,
  };
}

/** First sentence of a text (EN or ZH punctuation). */
export function firstSentence(text: string): string {
  const m = /^.*?(?:[.!?](?=\s|$)|[。！？])/s.exec(text.trim());
  return (m ? m[0] : text).trim();
}

const REFLECTION: Record<Topic, L10n> = {
  general: { en: "What would you do next if you trusted yourself a little more?", zh: "如果你再多相信自己一点，下一步会怎么做？" },
  love: { en: "What do you most want the other person to understand about you?", zh: "你最希望对方明白你的哪一点？" },
  work: { en: "Which part of this is actually within your control this week?", zh: "这件事里，哪一部分是你这周真正能掌控的？" },
  growth: { en: "What is this situation asking you to let go of?", zh: "这件事在提醒你放下什么？" },
};

/** Which position carries the main action line for each spread. */
const KEY_POSITION: Record<SpreadId, number> = { single: 0, triad: 1, relate: 2, choice: 3 };

function sideOf(card: CardData, reversed: boolean): CardSide {
  return reversed ? card.reversed : card.upright;
}

export function analyze(spread: SpreadId, drawn: DrawnCard[], topic: Topic, lookup: Lookup = getCard): Analysis {
  const def = SPREADS[spread];
  if (drawn.length !== def.count) throw new Error(`${spread} needs ${def.count} cards, got ${drawn.length}`);
  const cs = drawn.map((d) => ({ card: lookup(d.id), reversed: d.reversed }));

  const perCard: CardInsight[] = cs.map(({ card, reversed }, i) => {
    const side = sideOf(card, reversed);
    return {
      id: card.id,
      reversed,
      position: def.positions[i],
      name: card.name,
      keywords: side.keywords,
      phrase: { en: firstSentence(side.meaning.en), zh: firstSentence(side.meaning.zh) },
      meaning: side.meaning,
      topicLine: topic === "general" ? null : side[topic],
      advice: side.advice,
    };
  });

  const elementCounts: Record<Element, number> = { fire: 0, water: 0, air: 0, earth: 0 };
  cs.forEach(({ card }) => {
    const e = elementOf(card);
    if (e) elementCounts[e] += 1;
  });

  const patterns = findPatterns(cs);
  const choice = spread === "choice" ? scoreChoice(cs, topic) : null;
  const elem = elementSentence(elementCounts, cs.length);

  const parts: L10n[] = [opening(spread, cs)];
  if (elem.text) parts.push(elem.text);
  patterns.forEach((p) => parts.push(PATTERN_TEXT[p]));
  if (choice) parts.push(choiceSentence(choice));

  const key = cs[KEY_POSITION[spread]];
  const keySide = sideOf(key.card, key.reversed);
  const action = topic === "general" ? keySide.advice : keySide[topic];

  return {
    perCard,
    reflection: REFLECTION[topic],
    elementCounts,
    dominant: elem.dominant,
    patterns,
    choice,
    summary: { en: parts.map((p) => p.en).join(" "), zh: parts.map((p) => p.zh).join("") },
    action,
  };
}
