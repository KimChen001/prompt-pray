import type { Element, L10n } from "@/lib/tarot/types";

export type Sign =
  | "aries" | "taurus" | "gemini" | "cancer" | "leo" | "virgo"
  | "libra" | "scorpio" | "sagittarius" | "capricorn" | "aquarius" | "pisces";

export type Planet = "sun" | "moon" | "mercury" | "venus" | "mars" | "jupiter" | "saturn" | "uranus" | "neptune" | "pluto";
export type Modality = "cardinal" | "fixed" | "mutable";

export const SIGNS: Sign[] = ["aries", "taurus", "gemini", "cancer", "leo", "virgo", "libra", "scorpio", "sagittarius", "capricorn", "aquarius", "pisces"];
export const PLANETS: Planet[] = ["sun", "moon", "mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto"];

export const SIGN_INFO: Record<Sign, { name: L10n; element: Element; modality: Modality }> = {
  aries: { name: { en: "Aries", zh: "白羊座" }, element: "fire", modality: "cardinal" },
  taurus: { name: { en: "Taurus", zh: "金牛座" }, element: "earth", modality: "fixed" },
  gemini: { name: { en: "Gemini", zh: "双子座" }, element: "air", modality: "mutable" },
  cancer: { name: { en: "Cancer", zh: "巨蟹座" }, element: "water", modality: "cardinal" },
  leo: { name: { en: "Leo", zh: "狮子座" }, element: "fire", modality: "fixed" },
  virgo: { name: { en: "Virgo", zh: "处女座" }, element: "earth", modality: "mutable" },
  libra: { name: { en: "Libra", zh: "天秤座" }, element: "air", modality: "cardinal" },
  scorpio: { name: { en: "Scorpio", zh: "天蝎座" }, element: "water", modality: "fixed" },
  sagittarius: { name: { en: "Sagittarius", zh: "射手座" }, element: "fire", modality: "mutable" },
  capricorn: { name: { en: "Capricorn", zh: "摩羯座" }, element: "earth", modality: "cardinal" },
  aquarius: { name: { en: "Aquarius", zh: "水瓶座" }, element: "air", modality: "fixed" },
  pisces: { name: { en: "Pisces", zh: "双鱼座" }, element: "water", modality: "mutable" },
};

export const PLANET_NAME: Record<Planet | "asc" | "mc", L10n> = {
  sun: { en: "Sun", zh: "太阳" },
  moon: { en: "Moon", zh: "月亮" },
  mercury: { en: "Mercury", zh: "水星" },
  venus: { en: "Venus", zh: "金星" },
  mars: { en: "Mars", zh: "火星" },
  jupiter: { en: "Jupiter", zh: "木星" },
  saturn: { en: "Saturn", zh: "土星" },
  uranus: { en: "Uranus", zh: "天王星" },
  neptune: { en: "Neptune", zh: "海王星" },
  pluto: { en: "Pluto", zh: "冥王星" },
  asc: { en: "Ascendant", zh: "上升点" },
  mc: { en: "Midheaven", zh: "天顶" },
};

export const norm360 = (deg: number) => ((deg % 360) + 360) % 360;

export interface Placement {
  lon: number; // ecliptic longitude, 0–360, tropical
  sign: Sign;
  degree: number; // 0–29 within the sign
  minute: number; // 0–59
}

export function placement(lon: number): Placement {
  const l = norm360(lon);
  const idx = Math.floor(l / 30);
  const within = l - idx * 30;
  // Truncate (astrological convention) so the shown sign always matches the real position.
  const degree = Math.floor(within);
  const minute = Math.floor((within - degree) * 60);
  return { lon: l, sign: SIGNS[idx], degree, minute };
}

export function signOf(lon: number): Sign {
  return SIGNS[Math.floor(norm360(lon) / 30)];
}

/** "Leo 21°14′" / "狮子座 21°14′" */
export function formatPlacement(p: Placement, locale: "en" | "zh"): string {
  return `${SIGN_INFO[p.sign].name[locale]} ${p.degree}°${String(p.minute).padStart(2, "0")}′`;
}
