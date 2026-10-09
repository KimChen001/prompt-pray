"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import en, { type Messages } from "./en";
import zh from "./zh";
import type { L10n, L10nList, Locale } from "@/lib/tarot/types";
import { LOCALE_COOKIE } from "./config";
const DICTS: Record<Locale, Messages> = { en, zh };

type Vars = Record<string, string | number>;

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  m: Messages;
  fmt: (template: string, vars?: Vars) => string;
  pick: (value: L10n) => string;
  pickList: (value: L10nList) => string[];
}

const I18nContext = createContext<I18nValue | null>(null);

export function fmt(template: string, vars: Vars = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      m: DICTS[locale],
      fmt,
      pick: (v) => v[locale],
      pickList: (v) => v[locale],
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}
