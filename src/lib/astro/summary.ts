// Big Three as plain English sign names, for the tarot chart layer (opt-in) and the daily horoscope.
import { computeChart } from "./chart";
import { SIGN_INFO, type Sign } from "./zodiac";
import type { BirthData } from "./birth";

export interface BigThreeNames {
  sun?: string;
  moon?: string;
  rising?: string;
}

export function bigThreeNames(birth: BirthData): BigThreeNames {
  const b = computeChart(birth).bigThree;
  const name = (s?: Sign) => (s ? SIGN_INFO[s].name.en : undefined);
  return {
    sun: b.sun.placement ? name(b.sun.placement.sign) : b.sun.options ? `${name(b.sun.options[0])} or ${name(b.sun.options[1])}` : undefined,
    moon: b.moon.placement ? name(b.moon.placement.sign) : b.moon.options ? `${name(b.moon.options[0])} or ${name(b.moon.options[1])}` : undefined,
    rising: name(b.rising?.placement?.sign),
  };
}

/** The same Big Three in the reader's language, for showing what was shared ("Virgo or Libra" / "处女座或天秤座"). */
export function bigThreeLocalized(birth: BirthData, locale: "en" | "zh"): BigThreeNames {
  const b = computeChart(birth).bigThree;
  const name = (s?: Sign) => (s ? SIGN_INFO[s].name[locale] : undefined);
  const or = locale === "zh" ? "或" : " or ";
  const either = (c: { placement: { sign: Sign } | null; options: Sign[] | null }) =>
    c.placement ? name(c.placement.sign) : c.options ? `${name(c.options[0])}${or}${name(c.options[1])}` : undefined;
  return { sun: either(b.sun), moon: either(b.moon), rising: name(b.rising?.placement?.sign) };
}
