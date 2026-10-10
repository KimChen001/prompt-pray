// Key-field claim checks for AI text (overall review §1; P1 of the 2026-10-09 15:51 review). Every
// explicit astrology claim the patterns below recognise — "planet in sign", "sign planet", Rising,
// Midheaven, house, aspect, "as a Leo" — must match the facts of the source it is about:
//   natal – the person's birth chart (for the horoscope and tarot: their Sun / Moon / Rising signs)
//   sky   – today's sky, recomputed on the server (for the horoscope also its transits to the chart)
// Facts are kept per source and one source never vouches for the other: today's Moon in Libra can't
// make a natal Moon "Libra", nor settle an uncertain natal Moon (unknown birth time) on Libra.
//
// Which source a claim is about, in order:
//   1. words at the claim itself: before it ("your natal Moon", "today's Moon", "你的本命月亮",
//      "今天的月亮"), then verbs and words right after it ("enters Libra", "…in Libra today").
//      Words before the claim win over time words after it ("your Sun in Leo, today's…").
//      Someone else's placement ("his Sun", "对方的月亮") is not about either source and isn't checked;
//   2. a list continuing the previous claim ("your Sun in Leo and Moon in Aries", "你的太阳…，月亮…");
//   3. the nearest source word earlier in the same sentence ("When you were born, the Moon was…");
//   4. if only one source has facts about the body, that source; otherwise the product's default
//      (horoscope: today's sky), otherwise it must hold for both.
// A claim worded about a source that has no facts for it is treated as invented.
// An uncertain sign (unknown birth time) must be named with its other option right beside it
// ("Virgo or Libra", "处女座或天秤座"), unless the sentence is plainly hypothetical ("if your Moon is…").
// This is a backstop for common phrasings in English and Chinese, not a proof that every sentence is
// right: symbolic interpretation is never "verified", only its astronomical inputs are.
// Negated statements ("isn't in Pisces", "不在双鱼座") are not claims and are not flagged.
import { PLANETS, SIGNS, SIGN_INFO, PLANET_NAME, type Planet, type Sign } from "@/lib/astro/zodiac";
import type { Aspect } from "@/lib/astro/transits";

/** Bump when what the checker accepts changes; saved AI texts record the version they passed. */
export const CLAIM_RULES_VERSION = "claims@2";

export type ClaimSource = "natal" | "sky";
export type HouseBasis = "natal" | "solar";
/** A body an aspect can involve: a planet or the Ascendant. */
export type AspectPoint = Planet | "asc";
const SOURCES: ClaimSource[] = ["natal", "sky"];

export interface SourceFacts {
  /** Signs a body may be said to be in. Missing body = any sign claim about it is invented. */
  signs: Map<Planet, Set<Sign>>;
  /** Signs known for certain: naming one alone is fine. */
  certain: Map<Planet, Set<Sign>>;
  /** Bodies whose sign is uncertain (unknown birth time near a sign change): every option must be named together. */
  uncertain: Map<Planet, Set<Sign>>;
  /** Houses a body may be said to be in, with the basis they are counted on ("natal" chart or "solar" from the Sun sign). */
  houses: Map<Planet, Map<number, HouseBasis>>;
  /** Houses that may be mentioned with no planet named, with their basis; empty = no house talk. */
  anyHouse: Map<number, Set<HouseBasis>>;
  /** "a|b|aspect", both directions (b may be "asc"). */
  aspects: Set<string>;
  /** Context item ids behind facts: "sign|moon|libra", "house|moon|5", "aspect|mars|sun|square". */
  ids: Map<string, string>;
}

export interface ClaimFacts {
  natal: SourceFacts;
  sky: SourceFacts;
  /** Rising sign (natal), only when the birth time is known. */
  asc: Sign | null;
  ascId?: string;
  /** Midheaven sign (natal), only when the birth time is known. */
  mc: Sign | null;
  mcId?: string;
  /** When false, no "N°" / "N度" degree quotes are allowed (degrees are shown by the app, not the prose). */
  allowDegrees: boolean;
  /** Source assumed for a claim with no source wording when both sources have facts about the body. */
  unmarked: ClaimSource | "both";
}

const emptySource = (): SourceFacts => ({ signs: new Map(), certain: new Map(), uncertain: new Map(), houses: new Map(), anyHouse: new Map(), aspects: new Set(), ids: new Map() });

export function emptyClaimFacts(unmarked: ClaimFacts["unmarked"] = "both"): ClaimFacts {
  return { natal: emptySource(), sky: emptySource(), asc: null, mc: null, allowDegrees: false, unmarked };
}

function put<K, V>(map: Map<K, Set<V>>, k: K, v: V) {
  if (!map.has(k)) map.set(k, new Set());
  map.get(k)!.add(v);
}
const keep = (F: SourceFacts, key: string, id?: string) => {
  if (id && !F.ids.has(key)) F.ids.set(key, id);
};

/** A sign known for certain in this source. */
export function addSign(cf: ClaimFacts, source: ClaimSource, body: Planet, sign: Sign, id?: string) {
  const F = cf[source];
  put(F.signs, body, sign);
  put(F.certain, body, sign);
  keep(F, `sign|${body}|${sign}`, id);
}
/** Both possible signs of a body whose sign is uncertain in this source. */
export function addUncertain(cf: ClaimFacts, source: ClaimSource, body: Planet, options: Sign[], id?: string) {
  const F = cf[source];
  for (const s of options) {
    put(F.signs, body, s);
    keep(F, `sign|${body}|${s}`, id);
  }
  F.uncertain.set(body, new Set(options));
}
export function addHouse(cf: ClaimFacts, source: ClaimSource, body: Planet | null, house: number, id?: string, basis: HouseBasis = "natal") {
  const F = cf[source];
  put(F.anyHouse, house, basis);
  if (!body) return;
  if (!F.houses.has(body)) F.houses.set(body, new Map());
  F.houses.get(body)!.set(house, basis);
  keep(F, `house|${body}|${house}`, id);
}
/** Houses that may be named without a planet (e.g. all twelve when the birth time is known). */
export function allowHouses(cf: ClaimFacts, source: ClaimSource, houses: Iterable<number>, basis: HouseBasis = "natal") {
  for (const h of houses) put(cf[source].anyHouse, h, basis);
}
export function addAspect(cf: ClaimFacts, source: ClaimSource, a: AspectPoint, b: AspectPoint, aspect: Aspect, id?: string) {
  const F = cf[source];
  F.aspects.add(`${a}|${b}|${aspect}`).add(`${b}|${a}|${aspect}`);
  keep(F, `aspect|${a}|${b}|${aspect}`, id);
  keep(F, `aspect|${b}|${a}|${aspect}`, id);
}
export function setAsc(cf: ClaimFacts, sign: Sign, id?: string) {
  cf.asc = sign;
  cf.ascId = id;
}
export function setMc(cf: ClaimFacts, sign: Sign, id?: string) {
  cf.mc = sign;
  cf.mcId = id;
}

// ---------------------------------------------------------------------------------------------
// Vocabulary
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alt = (xs: string[]) => [...xs].sort((a, b) => b.length - a.length).map(esc).join("|");
const EN_PLANET = alt(PLANETS.map((p) => PLANET_NAME[p].en));
const ZH_PLANET = alt(PLANETS.map((p) => PLANET_NAME[p].zh));
const EN_SIGN_NAMES = SIGNS.map((s) => SIGN_INFO[s].name.en);
const EN_DEMONYM: Record<string, Sign> = {
  arian: "aries", taurean: "taurus", geminian: "gemini", cancerian: "cancer", leonine: "leo", virgoan: "virgo", virgoans: "virgo",
  libran: "libra", scorpionic: "scorpio", sagittarian: "sagittarius", capricornian: "capricorn", aquarian: "aquarius", piscean: "pisces",
};
const EN_SIGN = alt(EN_SIGN_NAMES);
const EN_SIGNISH = alt([...EN_SIGN_NAMES, ...Object.keys(EN_DEMONYM).map((d) => d[0].toUpperCase() + d.slice(1))]);
// Chinese sign names with or without the trailing 座 (双鱼座 / 双鱼).
const ZH_SIGN_SHORT = SIGNS.map((s) => SIGN_INFO[s].name.zh.replace(/座$/, ""));
const ZH_SIGN = `(?:${alt(ZH_SIGN_SHORT)})座?`;
const enPlanet = (name: string) => PLANETS.find((p) => PLANET_NAME[p].en.toLowerCase() === name.toLowerCase())!;
const zhPlanet = (name: string) => PLANETS.find((p) => PLANET_NAME[p].zh === name)!;
const enSign = (name: string): Sign => SIGNS.find((s) => SIGN_INFO[s].name.en.toLowerCase() === name.toLowerCase()) ?? EN_DEMONYM[name.toLowerCase()];
const zhSign = (name: string) => SIGNS.find((s) => SIGN_INFO[s].name.zh.replace(/座$/, "") === name.replace(/座$/, ""))!;
const anySign = (name: string): Sign | undefined => (/^[A-Za-z]/.test(name) ? enSign(name) : zhSign(name));

const EN_ASPECT: [RegExp, Aspect][] = [
  [/conjunct|conjunction/i, "conjunction"], [/sextil/i, "sextile"], [/squar/i, "square"], [/trin/i, "trine"], [/oppos/i, "opposition"],
];
const ZH_ASPECT: [RegExp, Aspect][] = [
  [/合相|相合|^合$/, "conjunction"], [/六分|六合/, "sextile"], [/四分|刑/, "square"], [/三分|拱/, "trine"], [/对分|冲/, "opposition"],
];
const ZH_ASPECT_WORD = "合相|相合|六分相|六分|六合|四分相|四分|三分相|三分|对分相|对分|对冲|相刑|相冲|相拱|刑|拱|冲(?!动|突|击|刺)";

const EN_ORDINAL: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };
const ZH_DIGIT: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const zhNumber = (s: string): number => {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  if (s.startsWith("十")) return 10 + ZH_DIGIT[s[1]];
  return ZH_DIGIT[s];
};
const ZH_NUM = "\\d{1,2}|十[一二]?|[一二三四五六七八九]";

// Planet → verb → sign. English: "Sun is in", "Sun sits in", "Sun, which is in", "Sun (in", "Moon today is in" …
const EN_COPULA = String.raw`(?:['’]s)?(?:\s*,\s*(?:which|that)\s+(?:is|sits|falls|lies)|\s*\(\s*(?:(?:now|currently|still|today)(?=\s))?|\s*,\s*(?:now|still|currently|retrograde|direct)|\s+(?:is|are|was|were|has|have|been|be|may|might|could|probably|likely|perhaps|possibly|maybe|always|ever|long|remains|stays|still|sits|sitting|lies|lying|falls|falling|resides|rests|stands|appears|lands|lives|placed|located|positioned|found|being|currently|now|today|tonight|also|both|likewise|here|there|firmly|squarely|comfortably|happily|really|actually|definitely|clearly|already|again|then|very\s+much|retrograde|direct|stationary|turns|turning|stations|stationing|goes|going|went))*`;
// "in", "into", "in the sign (of)", and the appositive ", in": "Your Moon, in Libra, …"
const EN_IN = String.raw`(?:\s*,\s*|\s+|-|(?<=\(\s*))in(?:to)?(?:\s+|-)(?:the\s+sign\s+(?:of\s+)?)?`;
// Chinese: 月亮在 / 月亮落在 / 月亮今天在 / 月亮也在 / 月亮可能在 / 月亮已经进入 …
const ZH_WHEN = "(?:也|都|则|还|仍然|仍|依然|就|便|已经|已|即将|刚刚|刚|将会|将|会|正在|正好|刚好|恰好|正|同样|其实|本来|可能|很可能|应该|大概|也许|或许|今天|今日|今晚|此刻|现在|目前|这几天|这两天|最近|此时|如今|当下)*";
const ZH_IN = "(?:坐落在|坐落于|落在|位于|落入|处在|处于|进入|移入|走进|来到|走到|回到|转入|踏入|抵达|行经|经过|运行到|运行至|运行在|运行于|落于|位在|是在|是|为|在|落)";
// "是/为" followed by a rulership phrase is not a placement: 火星是白羊座的守护星.
const NOT_RULER = "(?!座?(?:上升)?(?:点)?的?(?:守护星|守护|主宰))";

const AP = "['’]";
// ---- source wording ----
const EN_OTHER_PRE = new RegExp(String.raw`(?:\b(?:his|her|their|someone${AP}s|somebody${AP}s|people\s+with(?:\s+an?)?|those\s+with(?:\s+an?)?|anyone\s+with(?:\s+an?)?)|\b(?:partner|friend|mother|father|mom|dad|boss|sister|brother|child|son|daughter|ex|husband|wife|boyfriend|girlfriend|colleague|crush)${AP}s)\s+(?:[\w-]+\s+)?$`, "i");
const EN_NATAL_PRE = new RegExp(String.raw`(?:\byour\s+(?:[\w-]+\s+){0,2}|\b(?:natal|birth(?:-chart)?|radix|native)\s+|\bborn\s+(?:with|under)\s+(?:the\s+|an?\s+)?|\byou\s+have\s+(?:the\s+|an?\s+)?|\b(?:as|you${AP}re|you\s+are|being|for)\s+an?\s+|\bas\s+(?:someone|a\s+person|one)\s+with\s+(?:the\s+|an?\s+)?|\byou,\s+an?\s+|\b(?:in|of)\s+your\s+(?:birth\s+|natal\s+)?chart,?\s+(?:the\s+|your\s+)?)$`, "i");
const EN_NATAL_POST = new RegExp(String.raw`^\s*(?:(?:in|of)\s+your\s+(?:birth\s+|natal\s+)?chart|at\s+(?:your\s+)?birth|from\s+(?:your\s+)?birth|when\s+you\s+were\s+born|since\s+(?:your\s+)?birth|,?\s*like\s+(?:yours|you)|of\s+yours)\b`, "i");
const EN_SKY_PRE = new RegExp(String.raw`(?:\b(?:today${AP}s|tonight${AP}s|tomorrow${AP}s|this\s+(?:week|month|morning|evening|afternoon|weekend|season|year)${AP}s|next\s+(?:week|month)${AP}s|the\s+sky${AP}s|current|currently|transiting|transit)\s+(?:(?:new|full|waxing|waning|crescent|gibbous|quarter|first|last|dark|bright)\s+)*|\b(?:today|tonight|tomorrow|right\s+now|at\s+the\s+moment|at\s+present|currently|lately|these\s+days|for\s+now|this\s+(?:week|month|weekend|season|morning|evening|afternoon|year)|next\s+(?:week|month)|over\s+the\s+next\s+(?:few\s+)?(?:days|hours|weeks?)|in\s+today${AP}s\s+sky|in\s+the\s+sky|overhead)\s*,?\s+(?:the\s+)?|\b(?:new|full|waxing|waning|crescent|gibbous|first\s+quarter|last\s+quarter|quarter)\s+)$`, "i");
const EN_SKY_INSIDE = /\b(?:enters|entering|enter|entered|moves\s+into|moving\s+into|moved\s+into|slips\s+into|heads\s+into|glides\s+into|passes\s+into|shifts\s+into|steps\s+into|moves\s+through|moving\s+through|passes\s+through|passing\s+through|travels\s+through|travelling\s+through|traveling\s+through|transits|transiting|turns|turning|stations|stationing|currently|now|today|tonight)\b/i;
const EN_SKY_POST = new RegExp(String.raw`^\s*(?:today|tonight|tomorrow|this\s+(?:week|month|morning|evening|afternoon|weekend|season|year)|next\s+(?:week|month)|right\s+now|now|currently|at\s+the\s+moment|at\s+present|these\s+days|for\s+now|all\s+day|for\s+the\s+next|later\s+today|earlier\s+today|later\s+tonight|season|in\s+(?:today${AP}s|the)\s+sky|overhead)\b`, "i");
const EN_NATAL_WORDS = /\b(?:natal|birth[\s-]?chart|your\s+chart|born|at\s+(?:your\s+)?birth)\b/gi;
const EN_SKY_WORDS = new RegExp(String.raw`\b(?:today|tonight|tomorrow|this\s+(?:week|month|weekend|season|year|morning|evening|afternoon)|next\s+(?:week|month)|right\s+now|currently|at\s+the\s+moment|at\s+present|these\s+days|lately|over\s+the\s+next|transit(?:s|ing)?|in\s+the\s+sky|(?:${EN_SIGN})\s+season)\b`, "gi");
// A generic statement ("In general, a Cancer Moon tends to…", "A Venus in Taurus person usually…") is
// about nobody in particular: an article at the start of the clause plus general wording before or after.
const EN_GENERIC_CLAUSE = /^\s*(?:in\s+general,?\s*|generally,?\s*|typically,?\s*|usually,?\s*)(?:a|an|any|every)\s+$|^\s*(?:any|every)\s+$/i;
const EN_GENERIC_ARTICLE = /^\s*(?:a|an)\s+$/i;
const EN_GENERIC_POST = /^\s*(?:(?:person|people|types?|natives?|folks)\b|(?:[\w-]+\s+){0,2}(?:tends?\s+to|usually|often|typically|generally)\b)/i;

const ZH_OTHER_PRE = /(?:他|她|他们|她们|对方|伴侣|另一半|朋友|别人|家人|妈妈|爸爸|母亲|父亲|老板|同事|孩子|某人|有些人|很多人|一些人|其他人)的(?:本命)?\s*$/;
const ZH_NATAL_PRE = /(?:本命盘?(?:里|中|上)?的?|你的本命|你本命的?|您的本命|出生(?:时|盘|星盘)?(?:里|中|上)?的?|(?:个人)?星盘(?:里|中|上)的?|命盘(?:里|中|上)?的?|原生盘(?:里|中|上)?的?|天生的?|生来的?|你自己的|你的|您的|你是|作为|身为|像你这样的|像你一样的|你[一-鿿]{1,4}的|(?:^|[\s，,。.!！?？；;：:、（(和与跟同而但对])你)\s*$/;
const ZH_NATAL_POST = /^\s*的你/;
const ZH_OTHER_POST = /^\s*的(?:人|朋友|们)/;
const ZH_SKY_PRE = /(?:今天|今日|今晚|今夜|今早|今晨|此刻|此时|现在|目前|当前|当下|眼下|如今|今明两天|这两天|这几天|近几天|近日|近来|近期|最近|当天|本周|这周|这一周|本月|这个月|今年|这段时间|近段时间|这阵子|这一阵|行运的?|流运|天上|天空中|天空里)的?\s*[，,]?\s*$/;
const ZH_SKY_INSIDE = /今天|今日|今晚|此刻|此时|现在|目前|这几天|这两天|最近|如今|当下|正在|正与|正和|即将|将会|进入|移入|走进|走到|来到|转入|踏入|抵达|行经|经过|运行/;
const ZH_SKY_POST = /^\s*的(?:今天|这几天|这两天|今晚)/;
const ZH_NATAL_WORDS = /本命|星盘|命盘|原生盘|出生|天生|生来/g;
const ZH_SKY_WORDS = new RegExp(`今天|今日|今晚|今夜|今早|此刻|此时|当下|目前|如今|今明两天|这几天|这两天|最近|近来|近日|近期|当天|本周|这周|本月|这个月|今年|这段时间|行运|天象|天空|(?:${alt(ZH_SIGN_SHORT)})座?季`, "g");
const HYPOTHETICAL = /\b(?:if|whether|in\s+case|either|suppose|depending\s+on)\b|如果|假如|若是|要是|不论|无论|假设|取决于/i;

const BOUNDARY = /[.!?;。！？；\n]/;
const CLAUSE_BREAK = /[,，、:：;；]|\b(?:and|but|while|so|because|whereas)\b|而|但是|但|所以|因为|并且|同时/i;

function sentenceAt(text: string, start: number, end: number): [number, number] {
  let s = start;
  while (s > 0 && !BOUNDARY.test(text[s - 1])) s--;
  let e = end;
  while (e < text.length && !BOUNDARY.test(text[e])) e++;
  return [s, e];
}

/** Markdown emphasis, full-width digits and spaces, traditional characters and other sign names are normalised first. */
export function normalizeClaimText(text: string): string {
  const ZH_ALIASES: [RegExp, string][] = [
    [/寶瓶|宝瓶/g, "水瓶"], [/人马/g, "射手"], [/室女/g, "处女"], [/牡羊/g, "白羊"], [/魔羯/g, "摩羯"], [/天平座/g, "天秤座"],
    [/雙子/g, "双子"], [/天蠍/g, "天蝎"], [/獅子/g, "狮子"], [/處女/g, "处女"], [/雙魚/g, "双鱼"], [/太陽/g, "太阳"], [/宮/g, "宫"],
  ];
  let t = text.replace(/\*\*|__|[*`_]/g, "").replace(/　/g, " ").replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10));
  for (const [re, to] of ZH_ALIASES) t = t.replace(re, to);
  return t;
}

// ---------------------------------------------------------------------------------------------
type Lang = "en" | "zh";
type Kind = "sign" | "house" | "aspect" | "asc" | "mc" | "unknownBody" | "identity";

interface Claim {
  kind: Kind;
  lang: Lang;
  /** Span of the whole match; `anchor` is where the claim's subject starts (pre-context ends there). */
  start: number;
  end: number;
  anchor: number;
  text: string;
  planet?: Planet;
  sign?: Sign;
  signStart?: number;
  signEnd?: number;
  house?: number;
  basis?: HouseBasis | null;
  a?: AspectPoint;
  b?: AspectPoint;
  aspect?: Aspect;
  /** Source implied by the pattern itself (e.g. "Libra is your Moon sign" = natal; "enters" = sky). */
  hint?: ClaimSource;
  /** A plural like "Libra Suns": about people in general unless tied to the person ("like you"). */
  generic?: boolean;
}

type Scope = { strong: ClaimSource | "both" | "other" | null; weak: ClaimSource | null; sentence: [number, number] };

export interface ClaimCheck {
  /** The first claim that contradicts its source's facts (or overstates an uncertain one), or null. */
  bad: string | null;
  /** Context item ids behind the claims that were checked and hold (for the reply's basis). */
  used: string[];
}

function collect(t: string): Claim[] {
  const out: Claim[] = [];
  const add = (c: Claim) => out.push(c);
  const signSpan = (m: RegExpMatchArray, group: number) => {
    const s = m[group];
    const idx = m.index! + m[0].lastIndexOf(s);
    return { signStart: idx, signEnd: idx + s.length };
  };

  // ---- English ----
  for (const m of t.matchAll(new RegExp(String.raw`\b(${EN_PLANET})${EN_COPULA}${EN_IN}(${EN_SIGN})\b`, "gi"))) {
    add({ kind: "sign", lang: "en", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], planet: enPlanet(m[1]), sign: enSign(m[2]), ...signSpan(m, 2) });
  }
  // "Your Moon is Libra", "Your Moon (Libra)", "Your Moon sign, Libra," / "Moon sign: Libra"
  // A "Sun sign" / "Moon sign" is a birth-chart notion.
  for (const m of t.matchAll(new RegExp(String.raw`\b(${EN_PLANET})(?:${AP}s)?(?:\s+sign)?(?:\s+(?:is|was|remains|stays)(?:\s+(?:also|still|actually|really|definitely|clearly|likewise))?\s+|\s*\(\s*|\s*:\s*|\s+sign\s*[,:]\s*|\s+sign\s+(?:is\s+|of\s+)?)(${EN_SIGN})\b(?!\s+(?:season|energy))`, "gi"))) {
    add({ kind: "sign", lang: "en", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], planet: enPlanet(m[1]), sign: enSign(m[2]), ...signSpan(m, 2), ...(/^\w+(?:['’]s)?\s+sign\b/i.test(m[0]) ? { hint: "natal" as const } : {}) });
  }
  // "The Moon you were born with is in Libra", "The Moon in your chart is in Libra": the birth chart.
  for (const m of t.matchAll(new RegExp(String.raw`\b(${EN_PLANET})\s+(?:you\s+were\s+born\s+(?:with|under)|at\s+your\s+birth|in\s+your\s+(?:birth\s+|natal\s+)?chart)${EN_COPULA}${EN_IN}(${EN_SIGN})\b`, "gi"))) {
    add({ kind: "sign", lang: "en", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], planet: enPlanet(m[1]), sign: enSign(m[2]), ...signSpan(m, 2), hint: "natal" });
  }
  // "Your Moon, like today's Moon, is in Libra": both bodies are claims, each with its own source.
  for (const m of t.matchAll(new RegExp(String.raw`\b(${EN_PLANET})\s*,\s*like\s+((?:today|tonight)${AP}s\s+|the\s+|your\s+(?:natal\s+)?)(${EN_PLANET})\s*,${EN_COPULA}${EN_IN}(${EN_SIGN})\b`, "gi"))) {
    const second = m.index! + m[0].indexOf(m[2]) + m[2].length;
    add({ kind: "sign", lang: "en", start: m.index!, end: m.index! + m[1].length, anchor: m.index!, text: m[0], planet: enPlanet(m[1]), sign: enSign(m[4]), ...signSpan(m, 4) });
    add({ kind: "sign", lang: "en", start: second, end: second + m[3].length, anchor: second, text: m[0], planet: enPlanet(m[3]), sign: enSign(m[4]), ...signSpan(m, 4) });
  }
  // "Your Moon and today's Moon are both in Libra": the first body is a claim too.
  for (const m of t.matchAll(new RegExp(String.raw`\b(${EN_PLANET})\s+and\s+(?:(?:your|today${AP}s|tonight${AP}s|the|natal|transiting|current)\s+)*(${EN_PLANET})\s+(?:are|were)\s+(?:(?:both|also|each|all)\s+)?in\s+(${EN_SIGN})\b`, "gi"))) {
    add({ kind: "sign", lang: "en", start: m.index!, end: m.index! + m[1].length, anchor: m.index!, text: m[0], planet: enPlanet(m[1]), sign: enSign(m[3]), ...signSpan(m, 3) });
  }
  // "Libra is your Moon sign"
  for (const m of t.matchAll(new RegExp(String.raw`\b(${EN_SIGN})\s+is\s+(your|the)\s+(${EN_PLANET})\s+sign\b`, "gi"))) {
    add({ kind: "sign", lang: "en", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], planet: enPlanet(m[3]), sign: enSign(m[1]), signStart: m.index!, signEnd: m.index! + m[1].length, ...(m[2].toLowerCase() === "your" ? { hint: "natal" as const } : {}) });
  }
  // Movement into or through a sign is about the sky.
  for (const m of t.matchAll(new RegExp(String.raw`\b(${EN_PLANET})(?:\s+(?:is|will|has|have|just|now|today|tonight|currently|already|soon))*\s+(?:enters|entering|enter|entered|moves\s+into|moving\s+into|moved\s+into|slips\s+into|heads\s+into|glides\s+into|passes\s+into|shifts\s+into|steps\s+into|moves\s+through|moving\s+through|passes\s+through|passing\s+through|travels\s+through|travelling\s+through|traveling\s+through|transits|transiting)\s+(${EN_SIGN})\b`, "gi"))) {
    add({ kind: "sign", lang: "en", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], planet: enPlanet(m[1]), sign: enSign(m[2]), ...signSpan(m, 2), hint: "sky" });
  }
  // "Libra Moon", "Libran Sun", "Aries-Moon", plural "Libra Suns"
  for (const m of t.matchAll(new RegExp(String.raw`\b(${EN_SIGNISH})[\s-]+(${EN_PLANET})(s)?\b`, "gi"))) {
    add({ kind: "sign", lang: "en", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], planet: enPlanet(m[2]), sign: enSign(m[1]), signStart: m.index!, signEnd: m.index! + m[1].length, ...(m[3] ? { generic: true } : {}) });
  }
  // Rising / Ascendant ("Rising" is case-sensitive so "tension rising in Libra season" isn't one).
  for (const m of t.matchAll(new RegExp(String.raw`\b(${EN_SIGN})[\s-]+(?:Rising|rising|Ascendant|ascendant|ascending)\b|\b(${EN_SIGN})\s+on\s+(?:the|your)\s+(?:Ascendant|ascendant|Rising)\b`, "g"))) {
    const s = m[1] ?? m[2];
    add({ kind: "asc", lang: "en", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], sign: enSign(s) });
  }
  for (const m of t.matchAll(new RegExp(String.raw`\b(?:Rising|Ascendant|ascendant|[Rr]ising\s+sign)(?:\s+sign)?(?:${AP}s)?(?:\s+(?:is|was|falls|sits|lies|lands|placed|located|also))*(?:\s+in(?:\s+the\s+sign\s+of)?|\s+is|\s+of|\s*[:,(])\s*(${EN_SIGN})\b`, "g"))) {
    add({ kind: "asc", lang: "en", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], sign: enSign(m[1]) });
  }
  for (const m of t.matchAll(new RegExp(String.raw`\b(?:Midheaven|MC)(?:${AP}s)?(?:\s+(?:is|falls|sits|lies))*\s+(?:in\s+)?(${EN_SIGN})\b|\b(${EN_SIGN})\s+(?:Midheaven|MC)\b`, "g"))) {
    add({ kind: "mc", lang: "en", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], sign: enSign(m[1] ?? m[2]) });
  }
  // Bodies MOONA never gives facts about.
  for (const m of t.matchAll(new RegExp(String.raw`\b(?:Chiron|North\s+Node|South\s+Node|(?:Black\s+Moon\s+)?Lilith|Juno|Ceres|Pallas|Vesta|Part\s+of\s+Fortune)${EN_COPULA}${EN_IN}(${EN_SIGN})\b|\b(${EN_SIGN})\s+(?:Chiron|North\s+Node|South\s+Node|Lilith)\b`, "g"))) {
    add({ kind: "unknownBody", lang: "en", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0] });
  }
  // "As a Leo, …", "you're a Libra" — the person's Sun sign.
  for (const m of t.matchAll(new RegExp(String.raw`\b(?:[Aa]s\s+an?|[Yy]ou${AP}re\s+an?|[Yy]ou\s+are\s+an?|[Bb]eing\s+an?|[Ff]ellow)\s+(${EN_SIGNISH})\b(?![\s-]+(?:${EN_PLANET}|Rising|rising|Ascendant|ascendant|season|energy|sun|moon)\b)`, "g"))) {
    const idx = m.index! + m[0].lastIndexOf(m[1]);
    add({ kind: "identity", lang: "en", start: m.index!, end: m.index! + m[0].length, anchor: idx, text: m[0], planet: "sun", sign: enSign(m[1]), signStart: idx, signEnd: idx + m[1].length, hint: "natal" });
  }
  // Houses: "5th house", "fifth house", "5th-house", "house 5", "solar 3rd house", "natal 7th house"
  for (const m of t.matchAll(new RegExp(String.raw`\b(?:(\d{1,2})(?:st|nd|rd|th)|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth))[\s-]+(?:(solar|natal|birth[\s-]chart)\s+)?house\b(?:[\s-]+(${EN_PLANET})\b)?|\bhouse\s+(\d{1,2})\b`, "gi"))) {
    const n = m[1] ? Number(m[1]) : m[2] ? EN_ORDINAL[m[2].toLowerCase()] : Number(m[5]);
    const before = t.slice(Math.max(0, m.index! - 24), m.index!);
    const basisWord = (m[3] ?? before.match(/\b(solar|natal|birth[\s-]chart)(?:['’]s)?\s+$/i)?.[1] ?? (/^\s*\((?:counted\s+)?from\s+your\s+Sun/i.test(t.slice(m.index! + m[0].length)) ? "solar" : ""))?.toLowerCase();
    add({ kind: "house", lang: "en", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], house: n, basis: basisWord ? (basisWord === "solar" ? "solar" : "natal") : null, ...(m[4] ? { planet: enPlanet(m[4]) } : {}) });
  }
  // Aspects: "Mars squares your Sun", "Venus is conjunct your Moon", "Mars in a square with Sun", "… your Ascendant"
  const EN_POINT = `${EN_PLANET}|Ascendant|Rising`;
  for (const m of t.matchAll(new RegExp(String.raw`\b(${EN_PLANET})(?:\s+(?:is|are|was|currently|now|today|tonight|also|still|exactly|closely))*\s+(conjunct(?:ion\s+with|s|ing)?|sextil(?:e|es|ing)|squar(?:e|es|ing)|trin(?:e|es|ing)|oppos(?:ite|es|ing|ition\s+to)|in\s+opposition\s+to|(?:in|forms|makes|forming|making)\s+(?:a|an)\s+(?:(?:tight|close|exact|easy|tense|harmonious|challenging|wide|soft|hard|flowing|supportive|testing)\s+)?(?:square|trine|sextile|opposition|conjunction)\s+(?:with|to))(?:\s+(?:to|with))?\s+(?:(?:your|natal|the|birth|own)\s+)*(${EN_POINT})\b`, "gi"))) {
    const b = /^(ascendant|rising)$/i.test(m[3]) ? "asc" : enPlanet(m[3]);
    add({ kind: "aspect", lang: "en", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], a: enPlanet(m[1]), b, aspect: EN_ASPECT.find(([re]) => re.test(m[2]))?.[1] ?? "opposition" });
  }

  // ---- Chinese ----
  // 月亮在天秤座 / 太阳星座可能是天秤座 (a 太阳星座/月亮星座 is a birth-chart notion)
  for (const m of t.matchAll(new RegExp(`(${ZH_PLANET})\\s*(星座)?\\s*${ZH_WHEN}\\s*${ZH_IN}\\s*(${ZH_SIGN})${NOT_RULER}`, "g"))) {
    add({ kind: "sign", lang: "zh", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], planet: zhPlanet(m[1]), sign: zhSign(m[3]), ...signSpan(m, 3), ...(m[2] ? { hint: "natal" as const } : {}) });
  }
  // A clause with no subject (or 它) continues the previous one: "月亮是巨蟹座上升的守护星，落在白羊座".
  for (const m of t.matchAll(new RegExp(`[，,]\\s*(?:它|它则|而它)?\\s*${ZH_WHEN}\\s*(?:坐落在|坐落于|落在|位于|落入|处在|处于|落于)\\s*(${ZH_SIGN})`, "g"))) {
    const [s] = sentenceAt(t, m.index!, m.index! + m[0].length);
    let found: RegExpMatchArray | null = null;
    for (const p of t.slice(s, m.index!).matchAll(new RegExp(`(${ZH_PLANET})`, "g"))) if (!/^\s*(?:第|宫|星座)/.test(t.slice(s + p.index! + p[0].length))) found = p;
    if (!found) continue;
    const at = s + found.index!;
    add({ kind: "sign", lang: "zh", start: at, end: m.index! + m[0].length, anchor: at, text: `${found[1]}…${m[0]}`, planet: zhPlanet(found[1]), sign: zhSign(m[1]), ...signSpan(m, 1) });
  }
  // 你的月亮和今天的月亮都在天秤座 / 你的太阳和月亮在天秤座: the first body is a claim too.
  for (const m of t.matchAll(new RegExp(`(${ZH_PLANET})\\s*(?:和|与|跟|以及|及)\\s*(?:今天的|今晚的|你的|您的|本命的?|行运的?)?\\s*(${ZH_PLANET})\\s*${ZH_WHEN}\\s*(?:都|也都|同样|一起)?\\s*(?:在|落在|位于|是)\\s*(${ZH_SIGN})`, "g"))) {
    add({ kind: "sign", lang: "zh", start: m.index!, end: m.index! + m[1].length, anchor: m.index!, text: m[0], planet: zhPlanet(m[1]), sign: zhSign(m[3]), ...signSpan(m, 3) });
  }
  // 你的月亮，在天秤座 / 月亮星座：天秤座 / 太阳摩羯（shorthand）
  for (const m of t.matchAll(new RegExp(`(${ZH_PLANET})(?:星座)?\\s*[，,：:]\\s*(?:在|落在|位于|是)?\\s*(${ZH_SIGN})${NOT_RULER}|(${ZH_PLANET})(${ZH_SIGN})${NOT_RULER}`, "g"))) {
    const p = m[1] ?? m[3], s = m[2] ?? m[4];
    add({ kind: "sign", lang: "zh", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], planet: zhPlanet(p), sign: zhSign(s), ...signSpan(m, m[2] ? 2 : 4) });
  }
  // 天秤座月亮 / 天秤座的月亮 / 天秤座上升 (but not the "摩羯月亮" inside "太阳摩羯月亮白羊")
  for (const m of t.matchAll(new RegExp(`(?<!(?:${ZH_PLANET}|上升)\\s*)(${ZH_SIGN})(?:的)?(${ZH_PLANET}|上升)`, "g"))) {
    const s = zhSign(m[1]);
    if (m[2] === "上升") add({ kind: "asc", lang: "zh", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], sign: s });
    else add({ kind: "sign", lang: "zh", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], planet: zhPlanet(m[2]), sign: s, signStart: m.index!, signEnd: m.index! + m[1].length });
  }
  for (const m of t.matchAll(new RegExp(`上升(?:点|星座)?\\s*${ZH_WHEN}\\s*(?:是在|是|为|在|落在|位于|落于|落)?\\s*[：:]?\\s*(${ZH_SIGN})`, "g"))) {
    add({ kind: "asc", lang: "zh", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], sign: zhSign(m[1]) });
  }
  for (const m of t.matchAll(new RegExp(`(?:天顶|中天)点?\\s*${ZH_WHEN}\\s*(?:是在|是|为|在|落在|位于|落于|落)?\\s*[：:]?\\s*(${ZH_SIGN})`, "g"))) {
    add({ kind: "mc", lang: "zh", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], sign: zhSign(m[1]) });
  }
  for (const m of t.matchAll(new RegExp(`(?:凯龙星?|北交点|南交点|莉莉丝|婚神星|谷神星|智神星|灶神星|福点)\\s*${ZH_WHEN}\\s*${ZH_IN}?\\s*(${ZH_SIGN})`, "g"))) {
    add({ kind: "unknownBody", lang: "zh", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0] });
  }
  // 作为天秤座的你 / 你是天秤座 / 天秤座的你 — the person's Sun sign.
  for (const m of t.matchAll(new RegExp(`(?:作为|身为|你是)\\s*(${ZH_SIGN})(?!座?的?(?:${ZH_PLANET}|上升))|(?<!(?:${ZH_PLANET}|上升)\\s*)(${ZH_SIGN})的你`, "g"))) {
    const s = m[1] ?? m[2];
    const idx = m.index! + m[0].indexOf(s);
    add({ kind: "identity", lang: "zh", start: m.index!, end: m.index! + m[0].length, anchor: idx, text: m[0], planet: "sun", sign: zhSign(s), signStart: idx, signEnd: idx + s.length, hint: "natal" });
  }
  // 第 3 宫 / 第三宫 / 第 1 太阳宫 / 你的太阳第3宫 / 落在3宫
  for (const m of t.matchAll(new RegExp(`(太阳)?\\s*第\\s*(${ZH_NUM})\\s*(太阳)?\\s*宫(?:位)?|(?:在|落在|位于|落入|进入|走进|行经|经过|来到)\\s*(?:你的)?\\s*(?:本命盘的?|出生盘的?|星盘的?)?\\s*(${ZH_NUM})\\s*宫|(?<=(?:${ZH_PLANET}))\\s*(${ZH_NUM})\\s*宫`, "g"))) {
    const n = zhNumber(m[2] ?? m[4] ?? m[5]);
    const around = t.slice(Math.max(0, m.index! - 8), m.index! + m[0].length + 12);
    const solar = !!(m[1] || m[3]) || /从太阳星座起算|太阳宫/.test(around);
    const natal = (/本命盘|出生盘|星盘/.test(around) || /本命\s*$/.test(t.slice(Math.max(0, m.index! - 4), m.index!))) && !solar;
    // "太阳第3宫" is solar-house wording, not the Sun; the match then starts after it.
    const start = m[1] ? m.index! + m[0].indexOf("第") : m.index!;
    add({ kind: "house", lang: "zh", start, end: m.index! + m[0].length, anchor: start, text: m[0], house: n, basis: solar ? "solar" : natal ? "natal" : null });
  }
  // 火星四分相你的太阳 / 火星刑你的太阳 / 火星今天与你的太阳形成四分相 / 你的火星和太阳成四分相
  const ZH_POINT = `${ZH_PLANET}|上升点?`;
  // A bare 合 between two bodies ("火星合你的太阳") is a conjunction; a body must follow it.
  const ZH_OWNER = "(?:你的|您的|你)?\\s*(?:本命|出生)?(?:盘)?(?:的)?";
  for (const m of t.matchAll(new RegExp(`(${ZH_PLANET})\\s*${ZH_WHEN}\\s*(${ZH_ASPECT_WORD}|合)\\s*(?:着)?\\s*${ZH_OWNER}\\s*(${ZH_POINT})`, "g"))) {
    add({ kind: "aspect", lang: "zh", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], a: zhPlanet(m[1]), b: m[3].startsWith("上升") ? "asc" : zhPlanet(m[3]), aspect: ZH_ASPECT.find(([re]) => re.test(m[2]))![1] });
  }
  for (const m of t.matchAll(new RegExp(`(${ZH_PLANET})\\s*${ZH_WHEN}\\s*(?:与|和|跟|同)\\s*${ZH_OWNER}\\s*(${ZH_POINT})\\s*(?:之间)?\\s*${ZH_WHEN}\\s*(?:形成|呈现|呈|构成|成|有|组成)?\\s*(?:了)?\\s*(?:一个|一组)?\\s*(?:和谐的|紧张的|柔和的|有张力的)?\\s*(${ZH_ASPECT_WORD})`, "g"))) {
    add({ kind: "aspect", lang: "zh", start: m.index!, end: m.index! + m[0].length, anchor: m.index!, text: m[0], a: zhPlanet(m[1]), b: m[2].startsWith("上升") ? "asc" : zhPlanet(m[2]), aspect: ZH_ASPECT.find(([re]) => re.test(m[3]))![1] });
  }
  return out.sort((x, y) => x.anchor - y.anchor || x.start - y.start);
}

/** Signs named as alternatives right beside a claim's sign ("Virgo or Libra", "处女座或天秤座"), and where that list starts. */
function optionChain(t: string, c: Claim): { signs: Set<Sign>; start: number } {
  const signs = new Set<Sign>(c.sign ? [c.sign] : []);
  if (c.signStart === undefined || c.signEnd === undefined) return { signs, start: c.anchor };
  const SIGN_ANY = `${EN_SIGN}|${ZH_SIGN}`;
  let rest = t.slice(c.signEnd);
  const fwd = new RegExp(`^(?:\\s*[,(]?\\s*(?:or|/)\\s+(?:possibly\\s+|perhaps\\s+|maybe\\s+)?(?:in\\s+)?(?:the\\s+)?|\\s*/\\s*|\\s*-\\s*or\\s*-\\s*|\\s*(?:或者|或是|还是|或)\\s*(?:在|是)?\\s*)(${SIGN_ANY})`, "i");
  for (let m = rest.match(fwd); m; m = rest.match(fwd)) {
    const s = anySign(m[1]);
    if (!s) break;
    signs.add(s);
    rest = rest.slice(m[0].length);
  }
  let start = c.signStart;
  const back = new RegExp(`(${SIGN_ANY})(?:\\s+or\\s+|\\s*-\\s*or\\s*-\\s*|\\s*/\\s*|\\s*(?:或者|或是|还是|或)\\s*)$`, "i");
  for (let m = t.slice(0, start).match(back); m; m = t.slice(0, start).match(back)) {
    const s = anySign(m[1]);
    if (!s) break;
    signs.add(s);
    start = m.index!;
  }
  return { signs, start: Math.min(start, c.anchor) };
}

function nearestWord(pre: string, natal: RegExp, sky: RegExp): ClaimSource | null {
  const last = (re: RegExp) => {
    let i = -1;
    for (const m of pre.matchAll(re)) i = m.index! + m[0].length;
    return i;
  };
  const n = last(natal), s = last(sky);
  if (n < 0 && s < 0) return null;
  if (n === s) return null;
  return n > s ? "natal" : "sky";
}

function scopeOf(t: string, c: Claim, anchor: number, prev: { claim: Claim; scope: Scope } | null): Scope {
  const sentence = sentenceAt(t, anchor, c.end);
  const pre = t.slice(sentence[0], anchor);
  const inside = t.slice(c.start, c.end);
  const post = t.slice(c.end, sentence[1]);
  const en = c.lang === "en";
  if (en ? EN_OTHER_PRE.test(pre) : ZH_OTHER_PRE.test(pre)) return { strong: "other", weak: null, sentence };

  // 1. Words at the claim. Before it wins over after it.
  const natalPre = en ? EN_NATAL_PRE.test(pre) : ZH_NATAL_PRE.test(pre);
  const skyPre = en ? EN_SKY_PRE.test(pre) : ZH_SKY_PRE.test(pre);
  let strong: Scope["strong"] = null;
  if (natalPre && skyPre) strong = "both";
  else if (natalPre) strong = "natal";
  else if (skyPre) strong = "sky";
  else {
    const natalAfter = c.hint === "natal" || (en ? EN_NATAL_POST.test(post) : ZH_NATAL_POST.test(post));
    const skyAfter = c.hint === "sky" || (en ? EN_SKY_INSIDE.test(inside) || EN_SKY_POST.test(post) : ZH_SKY_INSIDE.test(inside) || ZH_SKY_POST.test(post));
    if (natalAfter && skyAfter) strong = "both";
    else if (natalAfter) strong = "natal";
    else if (skyAfter) strong = "sky";
  }
  if (c.hint && strong === null) strong = c.hint;

  // 2. A list continuing the previous claim inherits its source.
  if (strong === null && prev && (prev.scope.strong === "natal" || prev.scope.strong === "sky") && prev.claim.end <= anchor) {
    const between = t.slice(prev.claim.end, anchor);
    const listy = en ? /^\s*(?:,\s*)?(?:(?:and|&|plus|with)\s+)?(?:an?\s+|your\s+|the\s+|its\s+)?$/i.test(between) : /^\s*[，,、]?\s*(?:和|与|及|以及|跟)?\s*(?:你的|您的)?\s*$/.test(between);
    if (listy) strong = prev.scope.strong;
  }
  // Generic statements are about nobody in particular: "Libra Suns tend to…", "In general, a Cancer
  // Moon…", "天秤座月亮的人…". Tied to the person ("like you", "的你") they were already natal above.
  if (strong === null) {
    let clauseStart = anchor;
    while (clauseStart > sentence[0] && !CLAUSE_BREAK.test(t[clauseStart - 1])) clauseStart--;
    const clausePre = t.slice(clauseStart, anchor);
    const generic = en ? EN_GENERIC_CLAUSE.test(clausePre) || (EN_GENERIC_ARTICLE.test(clausePre) && EN_GENERIC_POST.test(post)) : ZH_OTHER_POST.test(post);
    if (c.generic || generic) return { strong: "other", weak: null, sentence };
  }
  // 3. The nearest source word earlier in the sentence.
  const weak = strong === null ? (en ? nearestWord(pre, EN_NATAL_WORDS, EN_SKY_WORDS) : nearestWord(pre, ZH_NATAL_WORDS, ZH_SKY_WORDS)) : null;
  return { strong, weak, sentence };
}

export function checkClaims(text: string, cf: ClaimFacts): ClaimCheck {
  const t = normalizeClaimText(text);
  const used = new Set<string>();
  const idOf = (F: SourceFacts, key: string) => (F.ids.has(key) ? [F.ids.get(key)!] : []);

  /** Which sources a claim must hold for. A source named by the wording counts even without facts (then it fails). */
  const targets = (scope: Scope, has: (F: SourceFacts) => boolean): ClaimSource[] => {
    if (scope.strong === "both") return SOURCES;
    if (scope.strong === "natal" || scope.strong === "sky") return [scope.strong];
    if (scope.weak) return [scope.weak];
    const withFacts = SOURCES.filter((src) => has(cf[src]));
    if (withFacts.length < 2) return withFacts;
    if (cf.unmarked !== "both") return [cf.unmarked];
    return withFacts;
  };
  const holds = (srcs: ClaimSource[], ok: (F: SourceFacts) => string[] | null): boolean => {
    if (!srcs.length) return false;
    const ids: string[] = [];
    for (const src of srcs) {
      const r = ok(cf[src]);
      if (!r) return false;
      ids.push(...r);
    }
    ids.forEach((id) => used.add(id));
    return true;
  };

  // First every claim's source, in text order (a list item inherits from the claim before it).
  const claims = collect(t);
  let prev: { claim: Claim; scope: Scope } | null = null;
  const resolved = claims.map((c) => {
    const chain = c.kind === "sign" || c.kind === "identity" ? optionChain(t, c) : { signs: new Set<Sign>(), start: c.anchor };
    const scope = scopeOf(t, c, chain.start, prev);
    prev = { claim: c, scope };
    return { c, chain, scope };
  });
  // Contrasting pairs name an uncertain sign's options one clause at a time ("With the Moon in Aries, …;
  // with the Moon in Taurus, …" / "如果是…；如果是…"): within one sentence (semicolons included),
  // birth-chart claims about the same body together must name every option.
  const sentenceKey = (i: number) => {
    let s = i;
    while (s > 0 && !/[.!?。！？\n]/.test(t[s - 1])) s--;
    return s;
  };
  const named = new Map<string, Set<Sign>>();
  for (const { c, chain, scope } of resolved) {
    if (c.kind !== "sign" || (scope.strong !== null && scope.strong !== "natal")) continue;
    const k = `${c.planet}|${sentenceKey(chain.start)}`;
    if (!named.has(k)) named.set(k, new Set());
    chain.signs.forEach((s) => named.get(k)!.add(s));
  }

  /** Bodies whose uncertain birth-chart options this text has already named together. */
  const stated = new Set<Planet>();
  for (const { c, chain, scope } of resolved) {
    if (scope.strong === "other") continue;
    // "If your Moon is in Virgo, …": a conditional in the claim's own clause names one option at a time.
    let clauseStart = chain.start;
    while (clauseStart > scope.sentence[0] && !CLAUSE_BREAK.test(t[clauseStart - 1])) clauseStart--;
    const hypothetical = HYPOTHETICAL.test(t.slice(clauseStart, c.end));

    let ok = true;
    if (c.kind === "sign" || c.kind === "identity") {
      const p = c.planet!, s = c.sign!;
      // An identity statement ("as a Leo") is checked only when the person's Sun is known here.
      if (c.kind === "identity" && !cf.natal.signs.has("sun")) continue;
      // An unlabelled hypothetical naming one of the birth chart's possible signs is about the birth chart,
      // and so is an unlabelled follow-up once the reply has named the options together ("Your Moon is in
      // Aries or Taurus. With the Moon in Aries, …; with the Moon in Taurus, …").
      const optionOfChart = scope.strong === null && !scope.weak && !!cf.natal.uncertain.get(p)?.has(s);
      const srcs: ClaimSource[] = optionOfChart && (hypothetical || stated.has(p)) ? ["natal"] : targets(scope, (F) => F.signs.has(p));
      const together = named.get(`${p}|${sentenceKey(chain.start)}`);
      ok = holds(srcs, (F) => {
        if (!F.signs.get(p)?.has(s)) return null;
        const unc = F.uncertain.get(p);
        if (unc?.has(s) && !F.certain.get(p)?.has(s) && !hypothetical && ![...unc].every((o) => chain.signs.has(o) || (F === cf.natal && together?.has(o)))) return null;
        return idOf(F, `sign|${p}|${s}`);
      });
      const unc = cf.natal.uncertain.get(p);
      if (ok && srcs.includes("natal") && unc && [...unc].every((o) => chain.signs.has(o))) stated.add(p);
    } else if (c.kind === "house") {
      const basisOk = (b: HouseBasis | undefined) => !c.basis || b === c.basis;
      const bound = c.planet ? { planet: c.planet, at: null } : bindPlanet(t, c);
      if (!bound) {
        ok = SOURCES.some((src) => [...(cf[src].anyHouse.get(c.house!) ?? [])].some(basisOk));
      } else {
        const pScope = bound.at === null ? scope : scopeOf(t, { ...c, start: bound.at, anchor: bound.at }, bound.at, null);
        if (pScope.strong === "other") continue;
        ok = holds(targets(pScope, (F) => F.houses.has(bound.planet)), (F) => (F.houses.get(bound.planet)?.has(c.house!) && basisOk(F.houses.get(bound.planet)!.get(c.house!)) ? idOf(F, `house|${bound.planet}|${c.house}`) : null));
      }
    } else if (c.kind === "aspect") {
      const { a, b, aspect } = c as Required<Pick<Claim, "a" | "b" | "aspect">>;
      ok = holds(targets(scope, (F) => [...F.aspects].some((k) => k.startsWith(`${a}|${b}|`))), (F) => (F.aspects.has(`${a}|${b}|${aspect}`) ? idOf(F, `aspect|${a}|${b}|${aspect}`) : null));
    } else if (c.kind === "asc" || c.kind === "mc") {
      const sign = c.kind === "asc" ? cf.asc : cf.mc;
      const id = c.kind === "asc" ? cf.ascId : cf.mcId;
      // Rising and Midheaven are birth-chart points only.
      ok = scope.strong !== "sky" && scope.strong !== "both" && sign === c.sign;
      if (ok && id) used.add(id);
    } else if (c.kind === "unknownBody") {
      ok = false;
    }
    if (!ok) return { bad: c.text, used: [] };
  }
  if (!cf.allowDegrees && /\d\s*(?:°|º|˚)|(?:\d+|[二三四五六七八九十][一二三四五六七八九十]*)\s*度(?!过|假)/.test(t)) return { bad: "quotes a degree", used: [] };
  return { bad: null, used: [...used] };
}

/** The planet a house claim is about: the nearest planet before it in the same clause of thought (or right after: "5th-house Moon"). */
function bindPlanet(t: string, c: Claim): { planet: Planet; at: number | null } | null {
  const [s] = sentenceAt(t, c.start, c.end);
  const before = t.slice(s, c.start);
  const re = c.lang === "en" ? new RegExp(String.raw`\b(${EN_PLANET})\b`, "gi") : new RegExp(`(${ZH_PLANET})`, "g");
  let found: RegExpMatchArray | null = null;
  // "太阳第3宫" / "太阳宫" / "太阳星座" is house or sign wording, not the Sun (checked against the whole text).
  for (const m of before.matchAll(re)) if (c.lang === "en" || !/^\s*(?:第|宫|星座)/.test(t.slice(s + m.index! + m[0].length))) found = m;
  if (!found) return null;
  const at = s + found.index!;
  const between = t.slice(at + found[0].length, c.start);
  if (between.length > 60) return null;
  if (/\b(?:and|but|while|so|because|whereas|which\s+means)\b|而|但|所以|因为|并且|同时|另外/i.test(between)) return null;
  if (/\d{1,2}(?:st|nd|rd|th)[\s-]+house|宫/.test(between)) return null;
  return { planet: c.lang === "en" ? enPlanet(found[1]) : zhPlanet(found[1]), at };
}

/** Returns the first claim that contradicts the facts of its source (or overstates an uncertain sign), or null. */
export function findInconsistentClaim(text: string, cf: ClaimFacts): string | null {
  return checkClaims(text, cf).bad;
}
