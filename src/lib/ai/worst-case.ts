// The largest request each purpose can send, built through the real prompt builders (spec §3.1), for
// planning: how many calls fit a window, and how much a paid reading pack must set aside. Admission
// itself always bounds the actual request, so a request larger than these only draws on slack.
// Chinese text is the worst case (3 UTF-8 bytes per character), so both locales are tried.
import "server-only";
import { DECK } from "@/lib/tarot/deck";
import { SPREADS } from "@/lib/tarot/spreads";
import type { SpreadId, Topic } from "@/lib/tarot/types";
import { NOTE_MAX, MAX_NOTES_SENT } from "@/lib/memory";
import { CHAT_LIMITS } from "@/lib/chat/limits";
import type { NatalFact } from "@/lib/astro/natal-facts";
import { PLANETS, SIGNS } from "@/lib/astro/zodiac";
import { TAROT_SCHEMA, tarotPrompt, type TarotRequest } from "./tarot-prompt";
import { CHAT_SCHEMA, chatPrompt } from "./chat-prompt";
import { TALK_SCHEMA, talkContext, talkPrompt, type TalkRequest } from "./talk-prompt";
import { NATAL_SCHEMA, natalPrompt, type NatalRequest } from "./natal-prompt";
import { HOROSCOPE_SCHEMA, horoscopePrompt, type HoroscopeRequest } from "./horoscope-prompt";
import { requestBoundMicro } from "./pricing";
import type { AiConfig } from "./config";
import type { ChatMessage, JsonRequest, Purpose } from "./types";

const CJK = "长";
const fill = (locale: "en" | "zh", n: number) => (locale === "zh" ? CJK : "W").repeat(n);
const TOPICS: Topic[] = ["general", "love", "work", "growth"];

function longestSpread(): SpreadId {
  return (Object.keys(SPREADS) as SpreadId[]).sort((a, b) => SPREADS[b].count - SPREADS[a].count)[0];
}

/** The cards with the longest text for a locale and topic, each in its longer orientation. */
function longestCards(locale: "en" | "zh", topic: Topic, n: number) {
  const scored = DECK.flatMap((c) => [false, true].map((reversed) => {
    const side = reversed ? c.reversed : c.upright;
    const len = Buffer.byteLength(side.meaning[locale] + side.keywords[locale].join(", ") + (topic === "general" ? "" : side[topic][locale]) + c.name[locale], "utf8");
    return { id: c.id, reversed, len };
  }));
  scored.sort((a, b) => b.len - a.len);
  const out: { id: string; reversed: boolean }[] = [];
  for (const s of scored) if (!out.some((o) => o.id === s.id) && out.length < n) out.push({ id: s.id, reversed: s.reversed });
  return out;
}

function tarotReq(locale: "en" | "zh", topic: Topic): TarotRequest {
  const spread = longestSpread();
  return {
    locale, spread, topic, question: fill(locale, 300), cards: longestCards(locale, topic, SPREADS[spread].count),
    chart: { sun: "Sagittarius or Capricorn", moon: "Sagittarius or Capricorn", rising: "Sagittarius" },
    notes: Array.from({ length: MAX_NOTES_SENT }, () => fill(locale, NOTE_MAX)),
  };
}

/** A conversation window as large as the limits allow (alternating, ending with the person). */
function fullWindow(locale: "en" | "zh", turns = CHAT_LIMITS.maxMessages): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  let total = 0;
  for (let i = 0; i < turns; i++) {
    const role: ChatMessage["role"] = (turns - i) % 2 === 1 ? "user" : "assistant";
    const max = role === "user" ? CHAT_LIMITS.userMergedMax : CHAT_LIMITS.assistantMax;
    const len = Math.min(max, CHAT_LIMITS.maxTotalChars - total);
    if (len <= 0) break;
    msgs.push({ role, content: fill(locale, len) });
    total += len;
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

function sized(purpose: Purpose, p: { system: string; messages: ChatMessage[] }, schema: JsonRequest["schema"], cfg: AiConfig): number {
  const req: JsonRequest = { purpose, system: p.system, messages: p.messages, schema, schemaName: purpose };
  return requestBoundMicro(req, cfg, cfg.maxOutput[purpose]);
}

/** A paid follow-up: the reading, what was shown, and up to the second follow-up turn. */
export function followupBoundMicro(cfg: AiConfig): number {
  let max = 0;
  for (const locale of ["en", "zh"] as const) for (const topic of TOPICS) {
    const reading = tarotReq(locale, topic);
    const messages: ChatMessage[] = [
      { role: "user", content: fill(locale, CHAT_LIMITS.userMergedMax) },
      { role: "assistant", content: fill(locale, CHAT_LIMITS.assistantMax) },
      { role: "user", content: fill(locale, CHAT_LIMITS.userMergedMax) },
    ];
    max = Math.max(max, sized("chat", chatPrompt({ locale, reading, shown: fill(locale, 4000), messages }), CHAT_SCHEMA, cfg));
  }
  return max;
}

const label = (i: number): NatalFact => ({ id: `asp.x${i}`, kind: "aspect", a: PLANETS[i % PLANETS.length], b: PLANETS[(i + 3) % PLANETS.length], aspect: "opposition", orb: 7.9, tight: false, timeIndependent: true, orbRange: [0.1, 7.9] } as NatalFact);

export function worstCaseBoundMicro(purpose: Purpose, cfg: AiConfig): number {
  let max = 0;
  for (const locale of ["en", "zh"] as const) {
    if (purpose === "tarot") {
      for (const topic of TOPICS) {
        const p = tarotPrompt(tarotReq(locale, topic));
        max = Math.max(max, sized("tarot", { system: p.system, messages: [{ role: "user", content: p.user }] }, TAROT_SCHEMA, cfg));
      }
    } else if (purpose === "chat") {
      for (const topic of TOPICS) {
        max = Math.max(max, sized("chat", chatPrompt({ locale, reading: tarotReq(locale, topic), shown: fill(locale, 4000), messages: fullWindow(locale) }), CHAT_SCHEMA, cfg));
      }
    } else if (purpose === "talk") {
      const facts = Array.from({ length: 40 }, (_, i) => label(i));
      const r: TalkRequest = { locale, messages: fullWindow(locale), chart: { timeKnown: true, facts }, today: { date: "2026-10-28", timeZone: "America/New_York" }, notes: Array.from({ length: MAX_NOTES_SENT }, (_, i) => ({ id: `n${i}`, text: fill(locale, NOTE_MAX) })) };
      const ctx = talkContext(r, new Date("2026-10-28T16:00:00Z"));
      max = Math.max(max, sized("talk", talkPrompt(r, ctx.items), TALK_SCHEMA, cfg));
    } else if (purpose === "natal") {
      const facts = Array.from({ length: 80 }, (_, i) => label(i));
      const themes = Array.from({ length: 5 }, (_, t) => ({ id: `theme.x${t}`, kind: "aspect", title: { en: fill("en", 300), zh: fill("zh", 300) }, evidenceIds: facts.slice(t * 16, t * 16 + 16).map((f) => f.id), limitations: [0, 1, 2].map(() => ({ en: fill("en", 400), zh: fill("zh", 400) })) }));
      const r: NatalRequest = { locale, timeKnown: true, factsVersion: "natal-facts@2", themesVersion: "natal-themes@2", facts, themes };
      const p = natalPrompt(r);
      max = Math.max(max, sized("natal", { system: p.system, messages: [{ role: "user", content: p.user }] }, NATAL_SCHEMA, cfg));
    } else {
      const r: HoroscopeRequest = { locale, date: "2026-10-28", timeZone: "America/New_York", tone: "tension", subject: { mode: "natal", timeKnown: true, sun: [SIGNS[8]], moon: [SIGNS[8], SIGNS[9]], rising: SIGNS[8] },
        facts: Array.from({ length: 8 }, (_, i) => ({ kind: "aspect" as const, transit: PLANETS[i % PLANETS.length], aspect: "opposition" as const, natal: "sun" as const, orb: 2 })) };
      const p = horoscopePrompt(r);
      max = Math.max(max, sized("horoscope", { system: p.system, messages: [{ role: "user", content: p.user }] }, HOROSCOPE_SCHEMA, cfg));
    }
  }
  return max;
}
