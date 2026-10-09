// Template horoscope (source: "Template"). Every sentence is generated from a real Fact, and the
// "why" list shows those facts, so the text is always traceable to the sky. The AI layer rewrites
// the same facts into prose; this module is its fallback.
import type { L10n } from "@/lib/tarot/types";
import { PLANET_NAME, SIGN_INFO, type Planet } from "./zodiac";
import { ASPECT_TONE, dayTone, type Fact, type NatalPoint, type Tone } from "./transits";

const HOUSE_THEME: L10n[] = [
  { en: "self and fresh starts", zh: "自我与新开始" },
  { en: "money and what you value", zh: "金钱与价值" },
  { en: "messages and your neighborhood", zh: "沟通与身边事" },
  { en: "home and family", zh: "家庭与归属" },
  { en: "creativity, play and romance", zh: "创造、玩乐与恋爱" },
  { en: "routines and daily work", zh: "日常节奏与工作" },
  { en: "partners and one-on-one ties", zh: "伴侣与一对一关系" },
  { en: "intimacy and shared resources", zh: "亲密与共享资源" },
  { en: "learning, travel and big ideas", zh: "学习、远行与信念" },
  { en: "career and reputation", zh: "事业与名声" },
  { en: "friends, groups and hopes", zh: "朋友、群体与愿望" },
  { en: "rest and the inner world", zh: "休息与内心世界" },
];

const POINT: Record<NatalPoint, L10n> = {
  sun: { en: "Sun", zh: "太阳" },
  moon: { en: "Moon", zh: "月亮" },
  asc: { en: "Rising", zh: "上升" },
};

// transit planet × tone → sentence about "your {point}"
const ASPECT_LINE: Record<"sun" | "moon" | "mercury" | "venus" | "mars", Record<Tone, L10n>> = {
  sun: {
    flow: { en: "The Sun supports your {point}: confidence comes easily, so spend it on something you care about.", zh: "太阳支持你的{point}：今天比较有底气，把它用在在乎的事情上。" },
    tension: { en: "The Sun presses on your {point}; pride may flare, so pick which battles matter.", zh: "太阳与你的{point}形成张力，容易较劲，想清楚哪些仗值得打。" },
    focus: { en: "The Sun lights up your {point}: a good day to be seen and to begin.", zh: "太阳照亮你的{point}：适合露面，也适合开始。" },
  },
  moon: {
    flow: { en: "Feelings run smoothly with your {point}; trust your gut on small choices.", zh: "情绪和你的{point}很合拍，小事上可以相信直觉。" },
    tension: { en: "Moods may swing against your {point}; give yourself a pause before reacting.", zh: "情绪可能和你的{point}拧着，先停一下再回应。" },
    focus: { en: "Emotions gather around your {point}; notice what you need, then say it.", zh: "情绪聚焦在你的{point}上，留意自己需要什么，然后说出来。" },
  },
  mercury: {
    flow: { en: "Conversations click with your {point}; send the message, ask the question.", zh: "沟通和你的{point}很顺，该发的消息发出去，该问的问题问出来。" },
    tension: { en: "Wires may cross around your {point}; reread before you hit send.", zh: "围绕你的{point}容易有误会，发送前再读一遍。" },
    focus: { en: "Your mind is busy around your {point}; write things down before they slip away.", zh: "你的{point}周围想法很多，趁没忘记先记下来。" },
  },
  venus: {
    flow: { en: "Venus smiles on your {point}: warmth, charm and small pleasures come easily.", zh: "金星眷顾你的{point}：温柔、魅力和小确幸都来得容易。" },
    tension: { en: "Venus tugs at your {point}; wanting harmony can mean saying yes too fast.", zh: "金星拉扯着你的{point}，为了和气容易答应得太快。" },
    focus: { en: "Venus meets your {point}: a moment for affection and for what you value.", zh: "金星与你的{point}相会：适合表达心意，也适合想想自己真正珍视什么。" },
  },
  mars: {
    flow: { en: "Mars backs your {point}: energy is high and effort pays off.", zh: "火星为你的{point}助力：精力充沛，付出有回报。" },
    tension: { en: "Mars rubs against your {point}; turn frustration into movement, not arguments.", zh: "火星与你的{point}摩擦，把烦躁变成行动，而不是争吵。" },
    focus: { en: "Mars charges your {point}: act on what you've been putting off.", zh: "火星点燃你的{point}：去做那件一直拖着的事。" },
  },
};

const TONE_LINE: Record<Tone, L10n> = {
  flow: { en: "A day with the wind at your back.", zh: "今天是顺风的一天。" },
  tension: { en: "A day with some friction, useful if you stay flexible.", zh: "今天有些摩擦，保持弹性就能化为助力。" },
  focus: { en: "A day for focus rather than speed.", zh: "今天适合专注，而不是求快。" },
};

const RETRO_LINE: Record<"mercury" | "venus" | "mars", L10n> = {
  mercury: { en: "Mercury is retrograde: double-check plans, travel details and messages.", zh: "水星逆行中：计划、行程和消息都多核对一遍。" },
  venus: { en: "Venus is retrograde: old feelings may resurface; take your time with new commitments.", zh: "金星逆行中：旧情绪可能浮现，新的承诺不必急着给。" },
  mars: { en: "Mars is retrograde: energy turns inward; refine rather than force.", zh: "火星逆行中：能量向内收，适合打磨，不适合硬推。" },
};

const LOVE_FALLBACK: Record<Tone, L10n> = {
  flow: { en: "In love, small gestures land well today.", zh: "感情上，今天的小心意很容易被接住。" },
  tension: { en: "In love, listen first; the other person may need space.", zh: "感情上先倾听，对方可能需要一点空间。" },
  focus: { en: "In love, say plainly what you want.", zh: "感情上，直接说出你想要的。" },
};
const WORK_FALLBACK: Record<Tone, L10n> = {
  flow: { en: "At work, momentum is on your side; finish one thing fully.", zh: "工作上势头不错，把一件事彻底做完。" },
  tension: { en: "At work, expect a snag; build in extra time.", zh: "工作上可能卡一下，多预留些时间。" },
  focus: { en: "At work, pick one priority and protect it.", zh: "工作上选一个重点，护住它。" },
};

const fill = (t: L10n, vars: Record<string, L10n>): L10n => ({
  en: t.en.replace(/\{(\w+)\}/g, (_, k) => vars[k]?.en ?? ""),
  zh: t.zh.replace(/\{(\w+)\}/g, (_, k) => vars[k]?.zh ?? ""),
});
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const pName = (p: Planet): L10n => PLANET_NAME[p];

/** One sentence per fact. */
export function factLine(f: Fact): L10n {
  switch (f.kind) {
    case "aspect": {
      const t = f.transit as keyof typeof ASPECT_LINE;
      const line = ASPECT_LINE[t]?.[ASPECT_TONE[f.aspect]];
      return line ? fill(line, { point: POINT[f.natal] }) : { en: "", zh: "" };
    }
    case "moonHouse":
      return {
        en: `The Moon moves through your ${ordinal(f.house)} house of ${HOUSE_THEME[f.house - 1].en} today.`,
        zh: `今天月亮行经你的第 ${f.house} 宫（${HOUSE_THEME[f.house - 1].zh}）。`,
      };
    case "retrograde":
      return RETRO_LINE[f.planet];
    case "event": {
      const e = f.event;
      const theme = f.house ? HOUSE_THEME[f.house - 1] : { en: "this part of your life", zh: "这个生活领域" };
      const sign = SIGN_INFO[e.sign].name;
      if (e.kind === "lunation") {
        const tpl: Record<typeof e.phase, L10n> = {
          new: { en: "New Moon in {sign} in your zone of {theme}: a clean slate, so set one intention.", zh: "{sign}新月落在你的「{theme}」：一张白纸，许下一个心愿。" },
          full: { en: "Full Moon in {sign} lights up {theme}: something peaks; release what is done.", zh: "{sign}满月照亮你的「{theme}」：有件事走到高点，放下已经完成的。" },
          firstQuarter: { en: "First Quarter Moon in {sign}: a checkpoint for {theme}; adjust and push on.", zh: "{sign}上弦月：「{theme}」的检查点，调整后继续推进。" },
          lastQuarter: { en: "Last Quarter Moon in {sign}: tidy up {theme} before the next cycle.", zh: "{sign}下弦月：在下个周期前整理好「{theme}」。" },
        };
        return fill(tpl[e.phase], { sign, theme });
      }
      const planet = pName(e.planet);
      if (e.kind === "ingress") return fill({ en: "{planet} enters {sign}, turning attention to {theme}.", zh: "{planet}进入{sign}，注意力转向「{theme}」。" }, { planet, sign, theme });
      if (e.kind === "stationRetrograde") return fill({ en: "{planet} turns retrograde in {sign}: slow down and review {theme}.", zh: "{planet}在{sign}开始逆行：放慢脚步，回顾「{theme}」。" }, { planet, sign, theme });
      return fill({ en: "{planet} turns direct in {sign}: stalled matters of {theme} start moving again.", zh: "{planet}在{sign}恢复顺行：「{theme}」中卡住的事重新动起来。" }, { planet, sign, theme });
    }
  }
}

const isLove = (f: Fact) =>
  (f.kind === "aspect" && (f.transit === "venus" || f.transit === "moon")) ||
  (f.kind === "moonHouse" && (f.house === 5 || f.house === 7)) ||
  (f.kind === "retrograde" && f.planet === "venus");
const isWork = (f: Fact) =>
  (f.kind === "aspect" && (f.transit === "mercury" || f.transit === "mars" || f.transit === "sun")) ||
  (f.kind === "moonHouse" && (f.house === 6 || f.house === 10)) ||
  (f.kind === "retrograde" && f.planet === "mercury");

export interface Horoscope {
  tone: Tone;
  overall: L10n;
  love: L10n;
  work: L10n;
  why: { fact: Fact; line: L10n }[];
}

const join = (parts: L10n[]): L10n => ({ en: parts.map((p) => p.en).join(" "), zh: parts.map((p) => p.zh).join("") });

export function composeHoroscope(facts: Fact[]): Horoscope {
  const tone = dayTone(facts);
  const used = new Set<Fact>();
  const take = (pred: (f: Fact) => boolean) => {
    const f = facts.find((x) => pred(x) && !used.has(x));
    if (f) used.add(f);
    return f;
  };

  const lead = take((f) => f.kind !== "retrograde" && f.kind !== "moonHouse");
  const moon = take((f) => f.kind === "moonHouse");
  const love = take(isLove);
  const work = take(isWork);

  return {
    tone,
    overall: join([TONE_LINE[tone], ...(lead ? [factLine(lead)] : []), ...(moon ? [factLine(moon)] : [])]),
    love: love ? factLine(love) : LOVE_FALLBACK[tone],
    work: work ? factLine(work) : WORK_FALLBACK[tone],
    why: facts.slice(0, 5).map((fact) => ({ fact, line: factLine(fact) })),
  };
}
