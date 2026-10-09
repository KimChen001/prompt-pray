// Big Three as plain English sign names — the only chart data sent to AI services (by opt-in).
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
