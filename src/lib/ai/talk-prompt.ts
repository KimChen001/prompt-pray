// Free conversation with MOONA ("Talk"): request parsing, prompt and validation. Pure functions.
// Context the person chose to share is kept in two labelled kinds the model must not blur:
//   SAID       – notes the person wrote or confirmed earlier (their own statements, maybe outdated)
//   CALCULATED – chart placements (computed in the browser from birth details that never leave it)
//                and today's sky (recomputed here on the server from the date and time zone)
// CALCULATED has two sources that are never merged: the birth chart (natal) and today's sky. MOONA's
// reply is symbolic reflection. It returns the ids of the context it relied on; the server keeps only
// ids it actually provided, rejects replies whose sign/house/aspect claims contradict the facts of the
// source they are about (claims.ts), and adds the facts behind every checked claim to the basis, so
// the chips always point to the right source.
import { detectCrisis } from "@/lib/safety";
import { NOTE_MAX, MAX_NOTES_SENT } from "@/lib/memory";
import { CHAT_LIMITS, parseMessages } from "@/lib/chat/limits";
import type { NatalFact } from "@/lib/astro/natal-facts";
import { factLabel } from "@/lib/astro/natal-text";
import { skyForDay, type SkyEvent } from "@/lib/astro/sky";
import { allPositions } from "@/lib/astro/ephemeris";
import { isValidTimeZone } from "@/lib/astro/birth";
import { PLANETS, PLANET_NAME, SIGN_INFO, signOf } from "@/lib/astro/zodiac";
import type { BasisItem, Locale } from "@/lib/tarot/types";
import { addSign, checkClaims, CLAIM_RULES_VERSION, type ClaimFacts } from "./claims";
import { natalClaimFacts, validFact } from "./natal-prompt";
import { pickSuggestion } from "./chat-prompt";
import type { ChatMessage, JsonSchema } from "./types";

// talk@2: birth chart and today's sky listed and checked as separate sources.
export const TALK_PROMPT_VERSION = "talk@2";
/** Recorded with each saved reply. */
export const TALK_VERSIONS = `${TALK_PROMPT_VERSION}|${CLAIM_RULES_VERSION}`;

export interface TalkRequest {
  locale: Locale;
  messages: ChatMessage[];
  chart?: { timeKnown: boolean; facts: NatalFact[] };
  today?: { date: string; timeZone: string };
  notes?: { id: string; text: string }[];
}

export interface ContextItem extends BasisItem {
  /** English text for the prompt. */
  prompt: string;
}

export const TALK_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    reply: { type: "string" },
    basis: { type: "array", items: { type: "string" } },
    remember: {
      type: "array",
      items: { type: "object", properties: { text: { type: "string" }, quote: { type: "string" } }, required: ["text", "quote"], additionalProperties: false },
    },
  },
  required: ["reply", "basis", "remember"],
  additionalProperties: false,
};

export interface TalkReply {
  reply: string;
  basis: BasisItem[];
  remember: { text: string; quote: string } | null;
}

const CHART_KINDS = new Set(["placement", "uncertainPlacement", "angle", "aspect"]);
const MAX_CHART_FACTS = 40;

/** Today's date must be within a day of the server's UTC date (any time zone on Earth). */
function plausibleToday(date: string, now: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.abs(d - today) <= 86400e3;
}

export function parseTalkRequest(body: unknown, now = new Date()): TalkRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const locale = b.locale === "zh" ? "zh" : b.locale === "en" ? "en" : null;
  if (!locale) return null;
  const messages = parseMessages(b.messages);
  if (!messages) return null;
  const req: TalkRequest = { locale, messages };

  if (b.chart !== undefined && b.chart !== null) {
    const c = b.chart as Record<string, unknown>;
    if (typeof c.timeKnown !== "boolean" || !Array.isArray(c.facts) || c.facts.length === 0 || c.facts.length > MAX_CHART_FACTS) return null;
    for (const f of c.facts as unknown[]) {
      const x = f as Record<string, unknown>;
      if (!x || typeof x !== "object" || !CHART_KINDS.has(x.kind as string) || !validFact(x)) return null;
      if (!c.timeKnown && (!x.timeIndependent || x.kind === "angle")) return null;
    }
    const facts = c.facts as NatalFact[];
    if (new Set(facts.map((f) => f.id)).size !== facts.length) return null;
    req.chart = { timeKnown: c.timeKnown, facts };
  }

  if (b.today !== undefined && b.today !== null) {
    const t = b.today as Record<string, unknown>;
    if (typeof t.date !== "string" || typeof t.timeZone !== "string" || t.timeZone.length > 64 || !isValidTimeZone(t.timeZone) || !plausibleToday(t.date, now)) return null;
    req.today = { date: t.date, timeZone: t.timeZone };
  }

  if (b.notes !== undefined && b.notes !== null) {
    if (!Array.isArray(b.notes) || b.notes.length > MAX_NOTES_SENT) return null;
    const notes: { id: string; text: string }[] = [];
    for (const n of b.notes as unknown[]) {
      const x = n as Record<string, unknown>;
      if (typeof x?.id !== "string" || !/^[\w-]{1,64}$/.test(x.id) || typeof x.text !== "string" || !x.text.trim() || x.text.length > NOTE_MAX) return null;
      notes.push({ id: x.id, text: x.text.trim() });
    }
    if (notes.length) req.notes = notes;
  }
  return req;
}

export function talkNeedsSupport(r: TalkRequest): boolean {
  return detectCrisis(r.messages[r.messages.length - 1].content) || (r.notes ?? []).some((n) => detectCrisis(n.text));
}

function describeEvent(e: SkyEvent): { en: string; zh: string } {
  const sign = SIGN_INFO[e.sign].name;
  if (e.kind === "lunation") {
    const phase = { new: ["New Moon", "新月"], firstQuarter: ["First Quarter Moon", "上弦月"], full: ["Full Moon", "满月"], lastQuarter: ["Last Quarter Moon", "下弦月"] }[e.phase];
    return { en: `${phase[0]} in ${sign.en}`, zh: `${sign.zh}${phase[1]}` };
  }
  const p = PLANET_NAME[e.planet];
  if (e.kind === "ingress") return { en: `${p.en} enters ${sign.en}`, zh: `${p.zh}进入${sign.zh}` };
  if (e.kind === "stationRetrograde") return { en: `${p.en} turns retrograde in ${sign.en}`, zh: `${p.zh}在${sign.zh}开始逆行` };
  return { en: `${p.en} turns direct in ${sign.en}`, zh: `${p.zh}在${sign.zh}恢复顺行` };
}

/** Every context item the request supports, with ids, labels and the claim facts behind them (per source). */
export function talkContext(r: TalkRequest, now = new Date()): { items: ContextItem[]; claims: ClaimFacts } {
  const L = r.locale;
  const items: ContextItem[] = [];
  const claims = natalClaimFacts({ facts: r.chart?.facts ?? [], timeKnown: !!r.chart?.timeKnown }, "chart.");
  for (const f of r.chart?.facts ?? []) {
    const label = factLabel(f);
    items.push({ id: `chart.${f.id}`, kind: "calc", label: L === "zh" ? `本命：${label.zh}` : `Birth chart: ${label.en}`, prompt: label.en });
  }
  if (r.today) {
    const sky = skyForDay(r.today.date, r.today.timeZone, now);
    const moon = SIGN_INFO[sky.moon.placement.sign].name;
    items.push({ id: "sky.moon", kind: "calc", label: L === "zh" ? `今天的月亮在${moon.zh}` : `Today's Moon in ${moon.en}`, prompt: `Today's Moon is in ${moon.en} (${sky.moon.phase} phase, ${Math.round(sky.moon.illumination * 100)}% lit)` });
    addSign(claims, "sky", "moon", sky.moon.placement.sign, "sky.moon");
    const pos = allPositions(sky.at);
    const list = PLANETS.filter((p) => p !== "moon").map((p) => ({ p, s: signOf(pos[p].lon) }));
    for (const { p, s } of list) addSign(claims, "sky", p, s, "sky.positions");
    items.push({
      id: "sky.positions",
      kind: "calc",
      label: L === "zh" ? `今天的天空：${list.map(({ p, s }) => `${PLANET_NAME[p].zh}在${SIGN_INFO[s].name.zh}`).join("，")}` : `Today's sky: ${list.map(({ p, s }) => `${PLANET_NAME[p].en} in ${SIGN_INFO[s].name.en}`).join(", ")}`,
      prompt: `Today's sky: ${list.map(({ p, s }) => `${PLANET_NAME[p].en} in ${SIGN_INFO[s].name.en}${sky.retrograde.includes(p) ? " (retrograde)" : ""}`).join(", ")}`,
    });
    sky.events.forEach((e, i) => {
      const d = describeEvent(e);
      const id = `sky.event.${i}`;
      // Before the ingress the planet was still in its previous sign (the next sign for a retrograde
      // planet); both are today's sky. A lunation names the Moon's sign at that moment.
      if (e.kind === "ingress") {
        addSign(claims, "sky", e.planet, e.sign, id);
        addSign(claims, "sky", e.planet, signOf(allPositions(new Date(e.at.getTime() - 60_000))[e.planet].lon), id);
      }
      if (e.kind === "lunation") addSign(claims, "sky", "moon", e.sign, id);
      items.push({ id, kind: "calc", label: L === "zh" ? `今天：${d.zh}` : `Today: ${d.en}`, prompt: `Today: ${d.en}` });
    });
  }
  for (const n of r.notes ?? []) items.push({ id: `note.${n.id}`, kind: "said", label: "", prompt: n.text });
  return { items, claims };
}

export function talkPrompt(r: TalkRequest, items: ContextItem[]): { system: string; messages: ChatMessage[] } {
  const language = r.locale === "zh" ? "Simplified Chinese (natural, not translated-sounding)" : "English";
  const said = items.filter((i) => i.kind === "said");
  const chart = items.filter((i) => i.id.startsWith("chart."));
  const sky = items.filter((i) => i.id.startsWith("sky."));
  const system = [
    "You are MOONA, a warm, grounded companion for reflection. You use tarot and astrology as a symbolic language for thinking things through, never as prediction or proof.",
    "Keep three kinds of information distinct and never blur them:",
    "1. SAID: things the person told MOONA earlier and confirmed. They may be out of date; what the person says now wins. You may ask once whether an old note still holds.",
    "2. CALCULATED: astronomical facts computed by the app, from two separate sources: the person's BIRTH CHART (fixed at birth) and TODAY'S SKY (where the planets are now). Use only these; never add, compute or change a planet, sign, house, aspect, degree or date. If no chart is listed, do not state the person's placements (you may suggest adding birth details). If no sky is listed, do not state where planets are today.",
    "Never mix the two sources. Whenever you name a placement, say whose it is: the chart's as 'your Moon' or 'your natal Moon' (Chinese: 你的月亮 / 你的本命月亮), the sky's as 'today's Moon' or 'the Moon today' (Chinese: 今天的月亮). The same planet usually sits in different signs in the two; never give one source's sign to the other. Today's sky never settles an uncertain birth-chart sign.",
    "3. Everything else you say is your own symbolic interpretation or a question. Phrase it that way ('one way to read this…', 'it may…').",
    "Do not quote degrees or orbs (the app shows them). Do not state houses or aspects for today's sky.",
    "Do not invent events, people or feelings in the person's life. Do not diagnose. Never give medical, legal or financial instructions. Never predict illness, death or pregnancy.",
    "Reply in 2–6 sentences (under 900 characters). Ask at most one question back.",
    "basis: the ids of the context items your reply actually relies on; [] if none.",
    "remember: usually empty. Add one item only when the person states a concrete, lasting fact about their situation that would help a later conversation. text = a short neutral note in their terms (under 120 characters); quote = their exact words from this conversation. Never infer feelings, traits or motives they did not state, and never repeat a SAID note.",
    `Write in ${language}. Return JSON with reply, basis and remember.`,
    "",
    "SAID (the person's own statements):",
    ...(said.length ? said.map((i) => `- [${i.id}] ${i.prompt}`) : ["- none shared"]),
    "",
    "CALCULATED · BIRTH CHART (natal):",
    ...(chart.length ? chart.map((i) => `- [${i.id}] ${i.prompt}`) : ["- none shared"]),
    "",
    "CALCULATED · TODAY'S SKY:",
    ...(sky.length ? sky.map((i) => `- [${i.id}] ${i.prompt}`) : ["- none shared"]),
    r.chart && !r.chart.timeKnown ? "The birth time is unknown: no Rising sign and no houses. If a Sun or Moon sign is uncertain, name both possible signs together." : "",
  ].filter((l) => l !== "").join("\n");
  return { system, messages: r.messages };
}

export function validateTalk(data: unknown, r: TalkRequest, items: ContextItem[], claims: ClaimFacts): TalkReply | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.reply !== "string" || !d.reply.trim() || d.reply.trim().length > CHAT_LIMITS.assistantMax) return null;
  const reply = d.reply.trim();
  if (detectCrisis(reply)) return null;
  const check = checkClaims(reply, claims);
  if (check.bad !== null) return null;
  // Basis: the ids MOONA cited that this request provided, plus the facts behind every claim it made
  // (so a claim about the birth chart always shows the chart fact, never only today's sky).
  const cited = Array.isArray(d.basis) ? d.basis.filter((x): x is string => typeof x === "string") : [];
  const wanted = new Set([...cited, ...check.used]);
  const basis = items.filter((i) => wanted.has(i.id)).map((it) => ({ id: it.id, kind: it.kind, label: it.label }));
  return { reply, basis, remember: pickSuggestion(d.remember, r.messages, (r.notes ?? []).map((n) => n.text)) };
}
