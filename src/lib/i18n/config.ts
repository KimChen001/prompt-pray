import type { Locale } from "@/lib/tarot/types";

export const LOCALE_COOKIE = "moona-locale";
export const DEFAULT_LOCALE: Locale = "en";

export function toLocale(value: string | undefined): Locale {
  return value === "zh" ? "zh" : DEFAULT_LOCALE;
}
