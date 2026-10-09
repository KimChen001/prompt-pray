// Key-field claim checks for AI text (overall review §1). Every explicit "planet in sign", "sign
// planet", Rising/Ascendant, house and aspect claim found in the text must match the facts the model
// was given. This is a backstop for common phrasings in English and Chinese, not a proof that every
// sentence is right: symbolic interpretation is never "verified", only its astronomical inputs are.
// Negated statements ("isn't in Pisces", "不在双鱼座") are not claims and are not flagged.
import { PLANETS, SIGNS, SIGN_INFO, PLANET_NAME, type Planet, type Sign } from "@/lib/astro/zodiac";
import type { Aspect } from "@/lib/astro/transits";

export interface ClaimFacts {
  /** Signs a body may be said to be in (natal and/or today's sky). Missing body = any sign claim is invented. */
  signs: Map<Planet, Set<Sign>>;
  /** Bodies whose sign is uncertain (unknown birth time near a sign change): every option must be named. */
  uncertain: Map<Planet, Set<Sign>>;
  /** Signs known for certain (a known placement, today's sky): naming one alone is fine. */
  certain: Map<Planet, Set<Sign>>;
  /** Houses a body may be said to be in. */
  houses: Map<Planet, Set<number>>;
  /** Houses that may be mentioned at all (e.g. solar houses of today's facts); empty = no house talk. */
  anyHouse: Set<number>;
  /** "a|b|aspect", both directions. */
  aspects: Set<string>;
  /** Rising sign, only when the birth time is known. */
  asc: Sign | null;
  /** When false, no "N° …" degree quotes are allowed (degrees are shown by the app, not the prose). */
  allowDegrees: boolean;
}

export function emptyClaimFacts(): ClaimFacts {
  return { signs: new Map(), uncertain: new Map(), certain: new Map(), houses: new Map(), anyHouse: new Set(), aspects: new Set(), asc: null, allowDegrees: false };
}

export function addSign(cf: ClaimFacts, body: Planet, sign: Sign, certain = true) {
  const add = (map: Map<Planet, Set<Sign>>) => {
    if (!map.has(body)) map.set(body, new Set());
    map.get(body)!.add(sign);
  };
  add(cf.signs);
  if (certain) add(cf.certain);
}
/** Both possible signs of a body whose sign is uncertain. */
export function addUncertain(cf: ClaimFacts, body: Planet, options: Sign[]) {
  for (const s of options) addSign(cf, body, s, false);
  cf.uncertain.set(body, new Set(options));
}
export function addHouse(cf: ClaimFacts, body: Planet | null, house: number) {
  cf.anyHouse.add(house);
  if (!body) return;
  if (!cf.houses.has(body)) cf.houses.set(body, new Set());
  cf.houses.get(body)!.add(house);
}
export function addAspect(cf: ClaimFacts, a: Planet, b: Planet, aspect: Aspect) {
  cf.aspects.add(`${a}|${b}|${aspect}`).add(`${b}|${a}|${aspect}`);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EN_PLANET = PLANETS.map((p) => PLANET_NAME[p].en).join("|");
const EN_SIGN = SIGNS.map((s) => SIGN_INFO[s].name.en).join("|");
const ZH_PLANET = PLANETS.map((p) => PLANET_NAME[p].zh).join("|");
// Chinese sign names with or without the trailing 座 (双鱼座 / 双鱼).
const ZH_SIGN_SHORT = SIGNS.map((s) => esc(SIGN_INFO[s].name.zh.replace(/座$/, "")));
const ZH_SIGN = `(?:${ZH_SIGN_SHORT.join("|")})座?`;
const enPlanet = (name: string) => PLANETS.find((p) => PLANET_NAME[p].en.toLowerCase() === name.toLowerCase())!;
const zhPlanet = (name: string) => PLANETS.find((p) => PLANET_NAME[p].zh === name)!;
const enSign = (name: string) => SIGNS.find((s) => SIGN_INFO[s].name.en.toLowerCase() === name.toLowerCase())!;
const zhSign = (name: string) => SIGNS.find((s) => SIGN_INFO[s].name.zh.replace(/座$/, "") === name.replace(/座$/, ""))!;
const EN_ASPECT: [RegExp, Aspect][] = [
  [/^conjunct|^conjunction/i, "conjunction"], [/^sextile/i, "sextile"], [/^square/i, "square"], [/^trine/i, "trine"], [/^oppos|^in opposition/i, "opposition"],
];
const ZH_ASPECT: Record<string, Aspect> = { 合相: "conjunction", 六分相: "sextile", 四分相: "square", 三分相: "trine", 对分相: "opposition" };

// "Sun is in", "Sun sits in", "Sun, which is in", "Sun (in", "Sun-in-", "Sun placed firmly in" …
const EN_COPULA = "(?:'s)?(?:\\s*,\\s*(?:which|that)\\s+(?:is|sits|falls|lies)|\\s*\\(|\\s+(?:is|was|sits|sitting|lies|lying|falls|falling|resides|rests|stands|appears|lands|placed|located|positioned|found|being|currently|now|also|here|there|firmly|squarely|comfortably|happily))*";
const EN_IN = "(?:\\s+|-)in(?:\\s+|-)(?:the\\s+sign\\s+of\\s+)?";
const ZH_IN = "(?:星座|星)?(?:落在|位于|落入|坐落在|坐落于|处在|处于|进入|是|为|在)";

/** Returns the first claim that contradicts the facts (or overstates an uncertain sign), or null. */
export function findInconsistentClaim(text: string, cf: ClaimFacts): string | null {
  const mentions = (s: Sign) => new RegExp(`\\b${SIGN_INFO[s].name.en}\\b`, "i").test(text) || text.includes(SIGN_INFO[s].name.zh.replace(/座$/, ""));
  const signOk = (p: Planet, s: Sign) => {
    const set = cf.signs.get(p);
    if (!set || !set.has(s)) return false;
    const unc = cf.uncertain.get(p);
    // An uncertain body may only be named together with its other possible sign(s) — unless the sign
    // is also known for certain from another fact (today's Moon), which is then what the sentence is about.
    if (unc && unc.has(s) && !cf.certain.get(p)?.has(s)) return [...unc].every(mentions);
    return true;
  };
  const aspectOk = (a: Planet, b: Planet, asp: Aspect) => cf.aspects.has(`${a}|${b}|${asp}`);
  const ascOk = (s: Sign) => cf.asc === s;
  const houseOk = (p: Planet | null, h: number) => {
    if (!cf.anyHouse.has(h)) return false;
    if (p === null) return true;
    const set = cf.houses.get(p);
    return !set || set.has(h);
  };

  // English
  for (const m of text.matchAll(new RegExp(`\\b(${EN_PLANET})${EN_COPULA}${EN_IN}(${EN_SIGN})\\b`, "gi"))) {
    if (!signOk(enPlanet(m[1]), enSign(m[2]))) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`\\b(${EN_PLANET})\\s+sign\\s+(?:is\\s+|of\\s+)?(${EN_SIGN})\\b`, "gi"))) {
    if (!signOk(enPlanet(m[1]), enSign(m[2]))) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`\\b(${EN_PLANET})\\s+(?:enters|entering|moves into|moving into|slips into|heads into)\\s+(${EN_SIGN})\\b`, "gi"))) {
    if (!signOk(enPlanet(m[1]), enSign(m[2]))) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`\\b(${EN_SIGN})\\s+(${EN_PLANET}|Rising|Ascendant)\\b`, "gi"))) {
    const s = enSign(m[1]);
    if (/^(rising|ascendant)$/i.test(m[2]) ? !ascOk(s) : !signOk(enPlanet(m[2]), s)) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`\\b(?:Rising|Ascendant)(?:\\s+sign)?\\s+(?:is\\s+)?(?:in\\s+)?(${EN_SIGN})\\b`, "gi"))) {
    if (!ascOk(enSign(m[1]))) return m[0];
  }
  for (const m of text.matchAll(/\b(?:(\d{1,2})(?:st|nd|rd|th)\s+(?:solar\s+)?house|house\s+(\d{1,2}))\b/gi)) {
    const before = text.slice(Math.max(0, m.index! - 48), m.index);
    const pm = before.match(new RegExp(`\\b(${EN_PLANET})\\b(?:\\s+(?:is|sits|lies|falls|placed|located|in|through|moves|moving|travels|your|the|today))*\\s*$`, "i"));
    if (!houseOk(pm ? enPlanet(pm[1]) : null, Number(m[1] ?? m[2]))) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`\\b(${EN_PLANET})\\s+(conjunct(?:ion with|s)?|sextiles?|squares?|trines?|oppos(?:ite|es|ition to)|in opposition to)\\s+(?:your\\s+|natal\\s+|the\\s+)?(${EN_PLANET})\\b`, "gi"))) {
    const asp = EN_ASPECT.find(([re]) => re.test(m[2]))?.[1] ?? "opposition";
    if (!aspectOk(enPlanet(m[1]), enPlanet(m[3]), asp)) return m[0];
  }

  // Chinese
  for (const m of text.matchAll(new RegExp(`(${ZH_PLANET})${ZH_IN}(${ZH_SIGN})`, "g"))) {
    if (!signOk(zhPlanet(m[1]), zhSign(m[2]))) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`(${ZH_SIGN})(${ZH_PLANET}|上升)`, "g"))) {
    const s = zhSign(m[1]);
    if (m[2] === "上升" ? !ascOk(s) : !signOk(zhPlanet(m[2]), s)) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`上升(?:点|星座)?(?:是|为|在|落在|位于)(${ZH_SIGN})`, "g"))) {
    if (!ascOk(zhSign(m[1]))) return m[0];
  }
  for (const m of text.matchAll(/第\s*(\d{1,2})\s*宫/g)) {
    const before = text.slice(Math.max(0, m.index! - 10), m.index);
    const pm = before.match(new RegExp(`(${ZH_PLANET})(?:今天)?(?:落在|位于|落入|在|行经|经过|进入)?(?:你的)?$`));
    if (!houseOk(pm ? zhPlanet(pm[1]) : null, Number(m[1]))) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`(${ZH_PLANET})(合相|六分相|四分相|三分相|对分相)(${ZH_PLANET})`, "g"))) {
    if (!aspectOk(zhPlanet(m[1]), zhPlanet(m[3]), ZH_ASPECT[m[2]])) return m[0];
  }
  for (const m of text.matchAll(new RegExp(`(${ZH_PLANET})(?:与|和|跟)(?:你的)?(?:本命)?(${ZH_PLANET})(?:之间)?(?:形成|呈|构成)?(?:了)?(合相|六分相|四分相|三分相|对分相)`, "g"))) {
    if (!aspectOk(zhPlanet(m[1]), zhPlanet(m[2]), ZH_ASPECT[m[3]])) return m[0];
  }
  if (!cf.allowDegrees && /\d\s*°/.test(text)) return "quotes a degree";
  return null;
}
