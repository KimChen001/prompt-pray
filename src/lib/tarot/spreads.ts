import type { L10n, SpreadId } from "./types";

export interface Spread {
  id: SpreadId;
  count: number;
  positions: L10n[];
}

export const SPREADS: Record<SpreadId, Spread> = {
  single: { id: "single", count: 1, positions: [{ en: "Guidance", zh: "指引" }] },
  triad: {
    id: "triad",
    count: 3,
    positions: [
      { en: "Past", zh: "过去" },
      { en: "Present", zh: "现在" },
      { en: "Future", zh: "未来" },
    ],
  },
  relate: {
    id: "relate",
    count: 3,
    positions: [
      { en: "You", zh: "你" },
      { en: "Them", zh: "对方" },
      { en: "The bond", zh: "你们之间" },
    ],
  },
  choice: {
    id: "choice",
    count: 4,
    positions: [
      { en: "Option A", zh: "选项 A" },
      { en: "Option B", zh: "选项 B" },
      { en: "Key factor", zh: "关键因素" },
      { en: "Outcome", zh: "走向" },
    ],
  },
};

export const SPREAD_ORDER: SpreadId[] = ["single", "triad", "relate", "choice"];

export function isSpreadId(value: unknown): value is SpreadId {
  return typeof value === "string" && value in SPREADS;
}

const CHOICE = /\b(or|vs\.?|versus|either)\b|还是|或者|二选一|选哪/i;
const RELATION = /\b(relationship|partner|boyfriend|girlfriend|husband|wife|crush|ex|dating|friendship)\b|对象|男朋友|女朋友|伴侣|喜欢的人|暧昧|前任|关系/i;

/** Highlights a spread that fits the question. The user can always pick another. */
export function suggestSpread(question: string): SpreadId {
  const q = question.trim();
  if (!q) return "single";
  if (CHOICE.test(q)) return "choice";
  if (RELATION.test(q)) return "relate";
  if (q.length > 40) return "triad";
  return "single";
}
