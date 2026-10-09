// Library (offline) text for natal themes, and human-readable labels for natal facts.
// Symbolic interpretation, not prediction: wording describes tendencies to reflect on.
import type { Element, L10n } from "@/lib/tarot/types";
import type { NatalFact } from "./natal-facts";
import type { Theme } from "./natal-themes";
import { ANGLE_NAME, ASPECT_NAME, ELEMENT_NAME, MODALITY_NAME, houseName } from "./labels";
import { HOUSE_THEME } from "./horoscope";
import { PLANET_NAME, SIGN_INFO, type Modality, type Planet, type Sign } from "./zodiac";
import type { Aspect } from "./transits";

export const NATAL_TEXT_VERSION = "natal-text@1";

export const SIGN_KEYWORDS: Record<Sign, L10n> = {
  aries: { en: "direct, brave, quick to start", zh: "直接、勇敢、行动快" },
  taurus: { en: "steady, sensual, loyal", zh: "稳定、重感受、忠诚" },
  gemini: { en: "curious, quick, talkative", zh: "好奇、敏捷、爱交流" },
  cancer: { en: "protective, intuitive, home-centered", zh: "守护、敏感、重归属" },
  leo: { en: "warm, expressive, proud", zh: "热情、爱表达、有自尊" },
  virgo: { en: "precise, helpful, observant", zh: "细致、乐于助人、善观察" },
  libra: { en: "fair, diplomatic, relationship-minded", zh: "公正、圆融、重关系" },
  scorpio: { en: "intense, private, transformative", zh: "深刻、内敛、善蜕变" },
  sagittarius: { en: "adventurous, frank, idealistic", zh: "爱冒险、坦率、理想化" },
  capricorn: { en: "ambitious, disciplined, patient", zh: "有抱负、自律、有耐心" },
  aquarius: { en: "independent, inventive, principled", zh: "独立、有创意、讲原则" },
  pisces: { en: "imaginative, empathetic, fluid", zh: "富想象、共情强、随性" },
};

export const PLANET_FUNCTION: Record<Planet, L10n> = {
  sun: { en: "your core sense of self", zh: "你的核心自我" },
  moon: { en: "your emotional needs", zh: "你的情绪需求" },
  mercury: { en: "how you think and speak", zh: "你的思考与表达" },
  venus: { en: "what you love and value", zh: "你所爱与所重视的" },
  mars: { en: "your drive and how you assert yourself", zh: "你的行动力与主张方式" },
  jupiter: { en: "where you grow and feel lucky", zh: "你成长与顺遂的方向" },
  saturn: { en: "where you build discipline and structure", zh: "你建立纪律与结构的地方" },
  uranus: { en: "your urge for freedom and change", zh: "你对自由与改变的渴望" },
  neptune: { en: "your imagination and ideals", zh: "你的想象与理想" },
  pluto: { en: "your capacity for deep transformation", zh: "你深层蜕变的力量" },
};

export const ASPECT_MEANING: Record<Aspect, L10n> = {
  conjunction: { en: "fused together, so they act as one", zh: "融为一体，彼此难以分开" },
  sextile: { en: "an easy opening that rewards a little effort", zh: "一个稍加努力就能打开的机会" },
  square: { en: "friction that can become your engine", zh: "摩擦，也可能成为你的动力" },
  trine: { en: "a natural flow that comes easily", zh: "天然顺畅、得来不费力" },
  opposition: { en: "a pull between two sides that asks for balance", zh: "两端之间的拉扯，需要找到平衡" },
};

const ELEMENT_TEXT: Record<Element, { dominant: L10n; absent: L10n }> = {
  fire: { dominant: { en: "Much of your chart is Fire: you tend to move toward action, enthusiasm and starting things.", zh: "你的星盘火象偏重：倾向于行动、热情和开创。" }, absent: { en: "There is little Fire in your chart: motivation may come from steadier sources than excitement.", zh: "你的星盘几乎没有火象：动力往往来自更稳定的来源，而不是一时兴奋。" } },
  earth: { dominant: { en: "Much of your chart is Earth: you tend to trust what is practical, tangible and proven.", zh: "你的星盘土象偏重：倾向于相信务实、具体、被验证过的东西。" }, absent: { en: "There is little Earth in your chart: routines and practical details may take conscious effort.", zh: "你的星盘几乎没有土象：日常规律和实际细节可能需要刻意经营。" } },
  air: { dominant: { en: "Much of your chart is Air: you tend to process life through ideas, words and connections.", zh: "你的星盘风象偏重：倾向于通过想法、语言和连结来理解生活。" }, absent: { en: "There is little Air in your chart: you may understand things by feeling or doing before naming them.", zh: "你的星盘几乎没有风象：你可能先感受或先做，再说得出道理。" } },
  water: { dominant: { en: "Much of your chart is Water: you tend to read the emotional currents around you.", zh: "你的星盘水象偏重：倾向于感知周围的情绪流动。" }, absent: { en: "There is little Water in your chart: feelings may be easier to act on than to dwell in.", zh: "你的星盘几乎没有水象：比起沉浸在情绪里，你可能更习惯把感受化为行动。" } },
};

const MODALITY_TEXT: Record<Modality, { dominant: L10n; absent: L10n }> = {
  cardinal: { dominant: { en: "Your chart leans Cardinal: you like to initiate and set things in motion.", zh: "你的星盘偏本位：喜欢发起、推动事情开始。" }, absent: { en: "Little Cardinal energy: starting from zero may feel harder than continuing.", zh: "本位能量较少：从零开始可能比延续更难。" } },
  fixed: { dominant: { en: "Your chart leans Fixed: once committed, you hold your course.", zh: "你的星盘偏固定：一旦投入，就会坚持到底。" }, absent: { en: "Little Fixed energy: staying with one thing for a long time may take intention.", zh: "固定能量较少：长期专注于一件事可能需要刻意坚持。" } },
  mutable: { dominant: { en: "Your chart leans Mutable: you adapt quickly and keep options open.", zh: "你的星盘偏变动：适应快，喜欢保留选择。" }, absent: { en: "Little Mutable energy: sudden changes of plan may feel unsettling.", zh: "变动能量较少：计划突然改变可能让你不安。" } },
};

const sign = (s: Sign) => SIGN_INFO[s].name;
const fill = (en: string, zh: string): L10n => ({ en, zh });

/** One-line, human-readable label for a fact (used in "Why this reading" and in AI prompts). */
export function factLabel(f: NatalFact): L10n {
  switch (f.kind) {
    case "placement": {
      const deg = `${f.degree}°${f.approximate ? "≈" : ""}`;
      const house = f.house ? houseName(f.house) : null;
      return fill(
        `${PLANET_NAME[f.body].en} in ${sign(f.sign).en} ${deg}${house ? `, ${house.en}` : ""}${f.retrograde ? ", retrograde" : ""}`,
        `${PLANET_NAME[f.body].zh}在${sign(f.sign).zh} ${deg}${house ? `，${house.zh}` : ""}${f.retrograde ? "，逆行" : ""}`,
      );
    }
    case "uncertainPlacement":
      return fill(
        `${PLANET_NAME[f.body].en} in ${sign(f.options[0]).en} or ${sign(f.options[1]).en} (changes sign at ${f.changesAt})`,
        `${PLANET_NAME[f.body].zh}在${sign(f.options[0]).zh}或${sign(f.options[1]).zh}（${f.changesAt} 换座）`,
      );
    case "angle":
      return fill(`${ANGLE_NAME[f.body].en} in ${sign(f.sign).en} ${f.degree}°`, `${ANGLE_NAME[f.body].zh}在${sign(f.sign).zh} ${f.degree}°`);
    case "aspect":
      return fill(
        `${PLANET_NAME[f.a].en} ${ASPECT_NAME[f.aspect].en} ${PLANET_NAME[f.b].en} (orb ${f.orb.toFixed(1)}°)`,
        `${PLANET_NAME[f.a].zh}${ASPECT_NAME[f.aspect].zh}${PLANET_NAME[f.b].zh}（容许度 ${f.orb.toFixed(1)}°）`,
      );
    case "angular":
      return f.onAngle
        ? fill(`${PLANET_NAME[f.body].en} on the ${ANGLE_NAME[f.onAngle].en} (${houseName(f.house).en})`, `${PLANET_NAME[f.body].zh}落在${ANGLE_NAME[f.onAngle].zh}（${houseName(f.house).zh}）`)
        : fill(`${PLANET_NAME[f.body].en} in the ${houseName(f.house).en} (an angular house)`, `${PLANET_NAME[f.body].zh}在${houseName(f.house).zh}（角宫）`);
    case "chartRuler":
      return fill(
        `Chart ruler: ${PLANET_NAME[f.ruler].en} (ruler of ${sign(f.ascSign).en} Rising) in ${sign(f.rulerSign).en}, ${houseName(f.rulerHouse).en}`,
        `命主星：${PLANET_NAME[f.ruler].zh}（${sign(f.ascSign).zh}上升的守护星）在${sign(f.rulerSign).zh}，${houseName(f.rulerHouse).zh}`,
      );
    case "stellium": {
      const names = f.bodies.map((b) => PLANET_NAME[b]);
      const where = f.scope === "sign" ? sign(f.sign) : houseName(f.house);
      return fill(`${names.map((n) => n.en).join(", ")} together in ${where.en}`, `${names.map((n) => n.zh).join("、")}同在${where.zh}`);
    }
    case "balance": {
      const name = f.dimension === "element" ? ELEMENT_NAME[f.value as Element] : MODALITY_NAME[f.value as Modality];
      const pct = Math.round(f.share * 100);
      return f.state === "dominant"
        ? fill(`${name.en} emphasis: ${pct}% of weighted placements`, `${name.zh}偏重：加权落点占 ${pct}%`)
        : fill(`No ${name.en} among weighted placements`, `加权落点中没有${name.zh}`);
    }
  }
}

/** Offline ("Library") paragraph for a theme, built only from its evidence facts. */
export function themeLibraryText(theme: Theme, byId: Map<string, NatalFact>): L10n {
  const ev = theme.evidenceIds.map((id) => byId.get(id)!).filter(Boolean);
  const first = ev[0];
  switch (theme.kind) {
    case "core": {
      const parts: L10n[] = [];
      for (const f of ev) {
        if (f.kind === "placement" && (f.body === "sun" || f.body === "moon")) {
          parts.push(fill(
            `${sign(f.sign).en} ${PLANET_NAME[f.body].en} (${SIGN_KEYWORDS[f.sign].en}) colors ${PLANET_FUNCTION[f.body].en}.`,
            `${sign(f.sign).zh}${PLANET_NAME[f.body].zh}（${SIGN_KEYWORDS[f.sign].zh}）为${PLANET_FUNCTION[f.body].zh}定下基调。`,
          ));
        }
        if (f.kind === "angle" && f.body === "asc") {
          parts.push(fill(`${sign(f.sign).en} Rising (${SIGN_KEYWORDS[f.sign].en}) shapes how you meet the world.`, `${sign(f.sign).zh}上升（${SIGN_KEYWORDS[f.sign].zh}）塑造你面对世界的方式。`));
        }
      }
      return { en: parts.map((p) => p.en).join(" "), zh: parts.map((p) => p.zh).join("") };
    }
    case "aspect": {
      if (first?.kind !== "aspect") break;
      return fill(
        `${PLANET_NAME[first.a].en} ${ASPECT_NAME[first.aspect].en} ${PLANET_NAME[first.b].en}: ${PLANET_FUNCTION[first.a].en} and ${PLANET_FUNCTION[first.b].en} are ${ASPECT_MEANING[first.aspect].en}.`,
        `${PLANET_NAME[first.a].zh}${ASPECT_NAME[first.aspect].zh}${PLANET_NAME[first.b].zh}：${PLANET_FUNCTION[first.a].zh}与${PLANET_FUNCTION[first.b].zh}之间，是${ASPECT_MEANING[first.aspect].zh}。`,
      );
    }
    case "angular": {
      if (first?.kind !== "angular") break;
      const theme = HOUSE_THEME[first.house - 1];
      return fill(
        `${PLANET_NAME[first.body].en} in your ${houseName(first.house).en} (${theme.en}) makes ${PLANET_FUNCTION[first.body].en} a visible, active part of your life.`,
        `${PLANET_NAME[first.body].zh}在你的${houseName(first.house).zh}（${theme.zh}），让${PLANET_FUNCTION[first.body].zh}成为生活中显眼而活跃的部分。`,
      );
    }
    case "ruler": {
      if (first?.kind !== "chartRuler") break;
      const theme = HOUSE_THEME[first.rulerHouse - 1];
      return fill(
        `Your chart ruler ${PLANET_NAME[first.ruler].en} sits in ${sign(first.rulerSign).en} in your ${houseName(first.rulerHouse).en}: life tends to steer you toward ${theme.en}.`,
        `你的命主星${PLANET_NAME[first.ruler].zh}在${sign(first.rulerSign).zh}、${houseName(first.rulerHouse).zh}：人生常把你引向「${theme.zh}」。`,
      );
    }
    case "stellium": {
      if (first?.kind !== "stellium") break;
      const where = first.scope === "sign" ? fill(`${sign(first.sign).en} (${SIGN_KEYWORDS[first.sign].en})`, `${sign(first.sign).zh}（${SIGN_KEYWORDS[first.sign].zh}）`) : fill(`your ${houseName(first.house).en} (${HOUSE_THEME[first.house - 1].en})`, `你的${houseName(first.house).zh}（${HOUSE_THEME[first.house - 1].zh}）`);
      return fill(`${first.bodies.length} planets gather in ${where.en}, concentrating a lot of your energy there.`, `${first.bodies.length} 颗行星聚集在${where.zh}，你的许多能量都集中在这里。`);
    }
    case "balance": {
      if (first?.kind !== "balance") break;
      const t = first.dimension === "element" ? ELEMENT_TEXT[first.value as Element] : MODALITY_TEXT[first.value as Modality];
      return first.state === "dominant" ? t.dominant : t.absent;
    }
  }
  return theme.title;
}
