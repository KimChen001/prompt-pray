// Theme layer (combined review, "主题层"): picks 3–5 deduplicated themes from the natal facts.
// `importance` is a design rule for ordering, not a statistical accuracy score.
// Bump THEME_RULES.version whenever any rule or weight changes.
import type { Element, L10n } from "@/lib/tarot/types";
import { NATAL_RULES, type Body, type NatalFact, type NatalFacts } from "./natal-facts";
import { ANGLE_NAME, ASPECT_NAME, ELEMENT_NAME, MODALITY_NAME, houseName } from "./labels";
import { PLANET_NAME, SIGN_INFO, type Planet } from "./zodiac";

export const THEME_RULES = {
  version: "natal-themes@1",
  min: 3,
  max: 5,
  /** A body may appear in at most this many selected themes (the core theme counts). */
  maxPerBody: 2,
  /** At most this many selected themes may share a life domain. */
  maxPerDomain: 2,
  /** At most one theme driven by generational planets (Uranus, Neptune, Pluto). */
  maxGenerational: 1,
  /** Aspects become theme candidates when tight, or when a luminary is involved within this orb. */
  luminaryAspectOrb: 5,
  weights: {
    core: 100,
    aspectBase: 60,
    aspectPerDegree: 4,
    aspectLuminary: 10,
    aspectHard: 4,
    angularBase: 55,
    angularPersonal: 10,
    angularOnAngle: 8,
    ruler: 48,
    stelliumBase: 50,
    stelliumPerExtra: 6,
    elementDominantBase: 42,
    elementAbsent: 38,
    modalityDominant: 36,
    generationalPenalty: 20,
  },
} as const;

export type Domain =
  | "identity" | "emotion" | "mind" | "love" | "drive" | "growth" | "structure"
  | "change" | "home" | "career" | "relationships" | "community" | "inner" | "resources";

const PLANET_DOMAIN: Record<Planet, Domain> = {
  sun: "identity", moon: "emotion", mercury: "mind", venus: "love", mars: "drive",
  jupiter: "growth", saturn: "structure", uranus: "change", neptune: "inner", pluto: "change",
};
const HOUSE_DOMAIN: Domain[] = ["identity", "resources", "mind", "home", "love", "structure", "relationships", "change", "growth", "career", "community", "inner"];
const ELEMENT_DOMAIN: Record<Element, Domain> = { fire: "drive", earth: "structure", air: "mind", water: "emotion" };

export type ThemeKind = "core" | "aspect" | "angular" | "ruler" | "stellium" | "balance";

export interface Theme {
  id: string;
  kind: ThemeKind;
  title: L10n;
  evidenceIds: string[];
  importance: number;
  domains: Domain[];
  bodies: Body[];
  generational: boolean;
  limitations: L10n[];
}

export interface ThemeSelection {
  version: string;
  factsVersion: string;
  themes: Theme[];
}

const isGenerational = (b: Body) => (NATAL_RULES.generational as readonly string[]).includes(b);
const isPersonal = (b: Body) => (NATAL_RULES.personal as readonly string[]).includes(b);
/** Concatenates localized fragments; fragments carry their own spacing. */
const join = (...parts: L10n[]): L10n => ({ en: parts.map((p) => p.en).join(""), zh: parts.map((p) => p.zh).join("") });

const LIMIT_RISING: L10n = { en: "Rising sign, houses and chart ruler need a birth time.", zh: "上升星座、宫位和命主星需要出生时间。" };
const LIMIT_APPROX: L10n = { en: "Birth time unknown: degrees are approximate (local noon).", zh: "出生时间未知：度数按当地中午近似。" };

function candidates(nf: NatalFacts): Theme[] {
  const W = THEME_RULES.weights;
  const out: Theme[] = [];
  const f = nf.facts;

  // Core: the Big Three as far as they are known.
  const sun = nf.byId.get("place.sun");
  const moon = nf.byId.get("place.moon");
  const asc = nf.byId.get("angle.asc");
  const coreLimits: L10n[] = [];
  if (!nf.timeKnown) coreLimits.push(LIMIT_RISING);
  for (const lum of [sun, moon]) {
    if (lum?.kind === "uncertainPlacement") {
      coreLimits.push({
        en: `${PLANET_NAME[lum.body].en} changes sign that day (${SIGN_INFO[lum.options[0]].name.en} → ${SIGN_INFO[lum.options[1]].name.en} at ${lum.changesAt}); its sign is not used for character statements.`,
        zh: `${PLANET_NAME[lum.body].zh}当天换座（${lum.changesAt} 从${SIGN_INFO[lum.options[0]].name.zh}进入${SIGN_INFO[lum.options[1]].name.zh}），不据此做性格判断。`,
      });
    }
  }
  const signOfFact = (x?: NatalFact): L10n | null => (x && (x.kind === "placement" || x.kind === "angle") ? SIGN_INFO[x.sign].name : null);
  const titleParts = [
    signOfFact(sun) && join(signOfFact(sun)!, { en: " Sun", zh: "太阳" }),
    signOfFact(moon) && join(signOfFact(moon)!, { en: " Moon", zh: "月亮" }),
    signOfFact(asc) && join(signOfFact(asc)!, { en: " Rising", zh: "上升" }),
  ].filter(Boolean) as L10n[];
  out.push({
    id: "theme.core",
    kind: "core",
    title: { en: titleParts.map((t) => t.en).join(", "), zh: titleParts.map((t) => t.zh).join("、") },
    evidenceIds: [sun, moon, asc].filter(Boolean).map((x) => x!.id),
    importance: W.core,
    domains: ["identity", "emotion"],
    bodies: ["sun", "moon", ...(asc ? (["asc"] as Body[]) : [])],
    generational: false,
    limitations: coreLimits,
  });

  for (const x of f) {
    if (x.kind === "aspect") {
      const luminary = x.a === "sun" || x.a === "moon" || x.b === "sun" || x.b === "moon";
      if (!x.tight && !(luminary && x.orb <= THEME_RULES.luminaryAspectOrb)) continue;
      if (!isPersonal(x.a) && !isPersonal(x.b)) continue; // e.g. Jupiter–Saturn: shared by a whole cohort
      const generational = isGenerational(x.a) || isGenerational(x.b);
      const hard = x.aspect === "square" || x.aspect === "opposition" || x.aspect === "conjunction";
      const importance = W.aspectBase - W.aspectPerDegree * x.orb + (luminary ? W.aspectLuminary : 0) + (hard ? W.aspectHard : 0) - (generational ? W.generationalPenalty : 0);
      out.push({
        id: `theme.${x.id}`,
        kind: "aspect",
        title: join(PLANET_NAME[x.a], { en: " ", zh: "" }, ASPECT_NAME[x.aspect], { en: " ", zh: "" }, PLANET_NAME[x.b]),
        evidenceIds: [x.id, `place.${x.a}`, `place.${x.b}`].filter((id) => nf.byId.has(id)),
        importance: +importance.toFixed(2),
        domains: [PLANET_DOMAIN[x.a], PLANET_DOMAIN[x.b]],
        bodies: [x.a, x.b],
        generational,
        limitations: nf.timeKnown ? [] : [LIMIT_APPROX],
      });
    }
    if (x.kind === "angular") {
      const generational = isGenerational(x.body);
      const importance = W.angularBase + (isPersonal(x.body) ? W.angularPersonal : 0) + (x.onAngle ? W.angularOnAngle : 0) - (generational ? W.generationalPenalty : 0);
      out.push({
        id: `theme.${x.id}`,
        kind: "angular",
        title: x.onAngle
          ? join(PLANET_NAME[x.body], { en: " on the ", zh: "落在" }, ANGLE_NAME[x.onAngle])
          : join(PLANET_NAME[x.body], { en: " in the ", zh: "落在" }, houseName(x.house)),
        // Cite an angle only when the planet actually sits on it.
        evidenceIds: [x.id, `place.${x.body}`, ...(x.onAngle ? [x.onAngle === "asc" || x.onAngle === "dsc" ? "angle.asc" : "angle.mc"] : [])].filter((id) => nf.byId.has(id)),
        importance,
        domains: [PLANET_DOMAIN[x.body], HOUSE_DOMAIN[x.house - 1]],
        bodies: [x.body],
        generational,
        limitations: [],
      });
    }
    if (x.kind === "chartRuler") {
      out.push({
        id: "theme.ruler",
        kind: "ruler",
        title: join({ en: "Chart ruler ", zh: "命主星" }, PLANET_NAME[x.ruler], { en: " in ", zh: "落在" }, SIGN_INFO[x.rulerSign].name, { en: ", ", zh: "、" }, houseName(x.rulerHouse)),
        evidenceIds: [x.id, "angle.asc", `place.${x.ruler}`].filter((id) => nf.byId.has(id)),
        importance: W.ruler,
        domains: ["identity", HOUSE_DOMAIN[x.rulerHouse - 1]],
        bodies: ["asc", x.ruler],
        generational: false,
        limitations: [],
      });
    }
    if (x.kind === "stellium") {
      const where = x.scope === "sign" ? SIGN_INFO[x.sign].name : houseName(x.house);
      out.push({
        id: `theme.${x.id}`,
        kind: "stellium",
        title: join({ en: "Stellium in ", zh: "星群：" }, where),
        evidenceIds: [x.id, ...x.bodies.map((b) => `place.${b}`)].filter((id) => nf.byId.has(id)),
        importance: W.stelliumBase + W.stelliumPerExtra * (x.bodies.length - NATAL_RULES.stelliumMin),
        domains: [x.scope === "sign" ? ELEMENT_DOMAIN[SIGN_INFO[x.sign].element] : HOUSE_DOMAIN[x.house - 1]],
        bodies: x.bodies,
        generational: false,
        limitations: [],
      });
    }
    if (x.kind === "balance") {
      const name = x.dimension === "element" ? ELEMENT_NAME[x.value as Element] : MODALITY_NAME[x.value as keyof typeof MODALITY_NAME];
      const importance =
        x.dimension === "modality" ? W.modalityDominant :
        x.state === "dominant" ? W.elementDominantBase + 20 * (x.share - NATAL_RULES.dominantShare) : W.elementAbsent;
      out.push({
        id: `theme.${x.id}`,
        kind: "balance",
        title: x.state === "dominant" ? join({ en: "Strong ", zh: "强烈的" }, name) : join({ en: "Little ", zh: "缺少" }, name),
        evidenceIds: [x.id],
        importance: +importance.toFixed(2),
        domains: x.dimension === "element" ? [ELEMENT_DOMAIN[x.value as Element]] : ["structure"],
        bodies: [],
        generational: false,
        limitations: nf.timeKnown ? [] : [LIMIT_RISING],
      });
    }
  }
  return out;
}

/** Deterministic selection of 3–5 themes under the diversity rules. */
export function selectThemes(nf: NatalFacts): ThemeSelection {
  const all = candidates(nf);
  const [core, ...rest] = all;
  rest.sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id));

  const picked: Theme[] = [core];
  const bodyCount = new Map<Body, number>();
  const domainCount = new Map<Domain, number>();
  let generational = 0;
  const add = (t: Theme) => {
    picked.push(t);
    t.bodies.forEach((b) => bodyCount.set(b, (bodyCount.get(b) ?? 0) + 1));
    t.domains.forEach((d) => domainCount.set(d, (domainCount.get(d) ?? 0) + 1));
    if (t.generational) generational++;
  };
  core.bodies.forEach((b) => bodyCount.set(b, 1));
  core.domains.forEach((d) => domainCount.set(d, 1));

  const fits = (t: Theme, strictDomains: boolean) =>
    t.bodies.every((b) => (bodyCount.get(b) ?? 0) < THEME_RULES.maxPerBody) &&
    (!t.generational || generational < THEME_RULES.maxGenerational) &&
    (!strictDomains || t.domains.some((d) => (domainCount.get(d) ?? 0) < THEME_RULES.maxPerDomain));

  for (const t of rest) {
    if (picked.length >= THEME_RULES.max) break;
    if (fits(t, true)) add(t);
  }
  // Relax the domain rule only if we are short of the minimum.
  for (const t of rest) {
    if (picked.length >= THEME_RULES.min) break;
    if (!picked.includes(t) && fits(t, false)) add(t);
  }
  return { version: THEME_RULES.version, factsVersion: nf.version, themes: picked };
}
