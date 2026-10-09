// Bilingual astrology labels shared by facts, themes and reports.
import type { Element, L10n } from "@/lib/tarot/types";
import type { Aspect } from "./transits";
import type { Modality } from "./zodiac";

export const ASPECT_NAME: Record<Aspect, L10n> = {
  conjunction: { en: "conjunct", zh: "合相" },
  sextile: { en: "sextile", zh: "六分相" },
  square: { en: "square", zh: "四分相" },
  trine: { en: "trine", zh: "三分相" },
  opposition: { en: "opposite", zh: "对分相" },
};

export const ELEMENT_NAME: Record<Element, L10n> = {
  fire: { en: "Fire", zh: "火象" },
  earth: { en: "Earth", zh: "土象" },
  air: { en: "Air", zh: "风象" },
  water: { en: "Water", zh: "水象" },
};

export const MODALITY_NAME: Record<Modality, L10n> = {
  cardinal: { en: "Cardinal", zh: "本位" },
  fixed: { en: "Fixed", zh: "固定" },
  mutable: { en: "Mutable", zh: "变动" },
};

export const ANGLE_NAME: Record<"asc" | "mc" | "dsc" | "ic", L10n> = {
  asc: { en: "Ascendant", zh: "上升点" },
  mc: { en: "Midheaven", zh: "天顶" },
  dsc: { en: "Descendant", zh: "下降点" },
  ic: { en: "IC", zh: "天底" },
};

export function houseName(n: number): L10n {
  const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return { en: `${n}${suffix} house`, zh: `第 ${n} 宫` };
}
