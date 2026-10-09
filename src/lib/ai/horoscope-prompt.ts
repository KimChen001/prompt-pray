// Prompt + validation for the AI horoscope. Pure functions so they are unit-testable.
import { detectCrisis } from "@/lib/safety";

export interface HoroscopeRequest {
  locale: "en" | "zh";
  date: string; // YYYY-MM-DD, the user's local day
  tone: "flow" | "tension" | "focus";
  subject: { sun?: string; moon?: string; rising?: string };
  facts: string[]; // already-localized sky facts, strongest first
}

export interface HoroscopeText {
  overall: string;
  love: string;
  work: string;
}

const MAX_FACTS = 8;
const MAX_FACT_LEN = 300;
const MAX_SECTION_LEN = 900;

export function parseHoroscopeRequest(body: unknown): HoroscopeRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
  const locale = b.locale === "zh" ? "zh" : b.locale === "en" ? "en" : null;
  const date = typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
  const tone = b.tone === "flow" || b.tone === "tension" || b.tone === "focus" ? b.tone : null;
  const facts = Array.isArray(b.facts) ? b.facts.filter((f): f is string => typeof f === "string" && f.length > 0 && f.length <= MAX_FACT_LEN).slice(0, MAX_FACTS) : [];
  const s = (b.subject ?? {}) as Record<string, unknown>;
  if (!locale || !date || !tone || facts.length === 0) return null;
  return { locale, date, tone, facts, subject: { sun: str(s.sun, 40), moon: str(s.moon, 60), rising: str(s.rising, 40) } };
}

export function horoscopePrompt(r: HoroscopeRequest): { system: string; user: string } {
  const language = r.locale === "zh" ? "Simplified Chinese (natural, not translated-sounding)" : "English";
  const system = [
    "You are MOONA, a warm, grounded astrology companion.",
    "Write today's horoscope using ONLY the sky facts provided. Do not invent planets, signs, aspects or dates.",
    "Each section is 2–3 sentences, in the second person, reflective and practical. Mention at least one concrete fact per section.",
    "Never be fatalistic. Never give medical, legal or financial instructions. Never predict illness, death or pregnancy.",
    `Write in ${language}.`,
    'Reply with JSON only, no prose and no code fences: {"overall": string, "love": string, "work": string}',
  ].join("\n");
  const who = [r.subject.sun && `Sun ${r.subject.sun}`, r.subject.moon && `Moon ${r.subject.moon}`, r.subject.rising && `Rising ${r.subject.rising}`]
    .filter(Boolean)
    .join(", ");
  const user = [
    `Date: ${r.date}`,
    who ? `The person: ${who}` : "The person: Sun sign only",
    `Overall tone of today's aspects: ${r.tone}`,
    "Sky facts (most important first):",
    ...r.facts.map((f) => `- ${f}`),
  ].join("\n");
  return { system, user };
}

/** Validates model output; returns null when it is unusable or unsafe. */
export function validateHoroscope(data: unknown): HoroscopeText | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= MAX_SECTION_LEN;
  if (!ok(d.overall) || !ok(d.love) || !ok(d.work)) return null;
  const out = { overall: d.overall.trim(), love: d.love.trim(), work: d.work.trim() };
  if (Object.values(out).some((t) => detectCrisis(t))) return null;
  return out;
}
