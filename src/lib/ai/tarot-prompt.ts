// Tarot AI: request parsing, prompt and output validation. Pure functions (unit-tested).
// The server rebuilds every card fact from card ids — card names and meanings sent by a client are
// never trusted — so the model only sees the cards that were actually drawn.
import { DECK, getCard, hasCard } from "@/lib/tarot/deck";
import { SPREADS, isSpreadId } from "@/lib/tarot/spreads";
import type { CardData, DrawnCard, Locale, SpreadId, Topic } from "@/lib/tarot/types";
import { detectCrisis } from "@/lib/safety";
import type { JsonSchema } from "./types";

const TOPICS: Topic[] = ["general", "love", "work", "growth"];
const MAX_QUESTION = 300;

export interface ChartLayer {
  sun?: string;
  moon?: string;
  rising?: string;
}

export interface TarotRequest {
  locale: Locale;
  spread: SpreadId;
  topic: Topic;
  question?: string;
  cards: DrawnCard[];
  chart?: ChartLayer;
}

export interface TarotText {
  cards: { position: number; insight: string }[];
  synthesis: string;
  action: string;
  reflection: string;
}

export const TAROT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: { position: { type: "integer" }, insight: { type: "string" } },
        required: ["position", "insight"],
        additionalProperties: false,
      },
    },
    synthesis: { type: "string" },
    action: { type: "string" },
    reflection: { type: "string" },
  },
  required: ["cards", "synthesis", "action", "reflection"],
  additionalProperties: false,
};

const shortStr = (v: unknown, max: number) => (typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : undefined);

export function parseChartLayer(v: unknown): ChartLayer | undefined {
  if (!v || typeof v !== "object") return undefined;
  const c = v as Record<string, unknown>;
  const layer = { sun: shortStr(c.sun, 40), moon: shortStr(c.moon, 60), rising: shortStr(c.rising, 40) };
  return layer.sun || layer.moon || layer.rising ? layer : undefined;
}

export function parseTarotRequest(body: unknown): TarotRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const locale = b.locale === "zh" ? "zh" : b.locale === "en" ? "en" : null;
  if (!locale || !isSpreadId(b.spread)) return null;
  const topic = TOPICS.includes(b.topic as Topic) ? (b.topic as Topic) : null;
  if (!topic || !Array.isArray(b.cards) || b.cards.length !== SPREADS[b.spread].count) return null;
  const cards: DrawnCard[] = [];
  for (const c of b.cards as unknown[]) {
    const x = c as Record<string, unknown>;
    if (typeof x?.id !== "string" || !hasCard(x.id) || typeof x.reversed !== "boolean") return null;
    cards.push({ id: x.id, reversed: x.reversed });
  }
  if (new Set(cards.map((c) => c.id)).size !== cards.length) return null;
  let question: string | undefined;
  if (b.question !== undefined && b.question !== null && b.question !== "") {
    if (typeof b.question !== "string" || b.question.length > MAX_QUESTION) return null;
    question = b.question.trim() || undefined;
  }
  return { locale, spread: b.spread, topic, question, cards, chart: parseChartLayer(b.chart) };
}

function cardFacts(r: TarotRequest): string[] {
  const L = r.locale;
  return r.cards.map((d, i) => {
    const c = getCard(d.id);
    const side = d.reversed ? c.reversed : c.upright;
    const lines = [
      `Position ${i} — ${SPREADS[r.spread].positions[i][L]}: ${c.name[L]}, ${d.reversed ? "reversed" : "upright"}`,
      `  keywords: ${side.keywords[L].join(", ")}`,
      `  meaning: ${side.meaning[L]}`,
    ];
    if (r.topic !== "general") lines.push(`  ${r.topic}: ${side[r.topic][L]}`);
    return lines.join("\n");
  });
}

export function tarotPrompt(r: TarotRequest): { system: string; user: string } {
  const language = r.locale === "zh" ? "Simplified Chinese (natural, not translated-sounding)" : "English";
  const system = [
    "You are MOONA, a warm, grounded tarot reader. Tarot here is a tool for reflection, not prediction.",
    "Interpret ONLY the cards listed, in their positions and orientations. Never mention, add or swap other cards.",
    "Use the given meanings as the basis; you may phrase freshly and connect the cards to each other and to the question.",
    "If there is a question, speak to it directly. Do not invent facts about the person's life; if you assume something, say it is a possibility.",
    "If a chart layer is given, you may refer to it lightly; never compute or invent placements.",
    "Never give medical, legal or financial instructions. Never predict illness, death or pregnancy. Never be fatalistic.",
    "Per card: 2–3 sentences. synthesis: 3–4 sentences. action: one small thing to do today. reflection: one open question for the person.",
    `Write in ${language}. Return JSON with cards (one entry per position, with its position number), synthesis, action and reflection.`,
  ].join("\n");
  const user = [
    `Spread: ${r.spread} (${SPREADS[r.spread].count} card${SPREADS[r.spread].count > 1 ? "s" : ""})`,
    `Topic: ${r.topic}`,
    r.question ? `Question: ${r.question}` : "Question: none (give general guidance)",
    r.chart ? `Chart layer (user opted in): ${[r.chart.sun && `Sun ${r.chart.sun}`, r.chart.moon && `Moon ${r.chart.moon}`, r.chart.rising && `Rising ${r.chart.rising}`].filter(Boolean).join(", ")}` : "",
    "Cards:",
    ...cardFacts(r),
  ].filter(Boolean).join("\n");
  return { system, user };
}

// ---- output validation ----

// Major Arcana names that are also everyday words are not used to detect invented cards.
const COMMON_ZH = new Set(["恋人", "力量", "隐士", "正义", "死神", "节制", "恶魔", "星星", "月亮", "太阳", "审判", "世界"]);
const COMMON_EN = new Set(["Strength", "Justice", "Death", "Temperance", "Judgement"]);
const LUMINARY_EN = new Set(["The Sun", "The Moon"]);

/** Distinctive card names, to catch the model mentioning cards that were not drawn. */
export function distinctiveNames(card: CardData, chartIncluded: boolean): string[] {
  const out: string[] = [];
  if (!COMMON_EN.has(card.name.en) && !(chartIncluded && LUMINARY_EN.has(card.name.en))) out.push(card.name.en);
  if (!COMMON_ZH.has(card.name.zh)) out.push(card.name.zh);
  return out;
}

export function mentionsUndrawnCard(texts: string[], drawnIds: string[], chartIncluded: boolean): string | null {
  const drawn = new Set(drawnIds);
  const all = texts.join("\n");
  for (const card of DECK) {
    if (drawn.has(card.id)) continue;
    for (const name of distinctiveNames(card, chartIncluded)) if (all.includes(name)) return name;
  }
  return null;
}

const UPRIGHT = /\bupright\b|正位/i;
const REVERSED = /\breversed\b|逆位/i;

/** Returns validated text or null (wrong shape, missing/duplicate positions, invented cards, flipped orientation, unsafe). */
export function validateTarot(data: unknown, r: TarotRequest): TarotText | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const synthesis = shortStr(d.synthesis, 1500);
  const action = shortStr(d.action, 400);
  const reflection = shortStr(d.reflection, 400);
  if (!synthesis || !action || !reflection || !Array.isArray(d.cards) || d.cards.length !== r.cards.length) return null;

  const cards: TarotText["cards"] = [];
  for (const c of d.cards as unknown[]) {
    const x = c as Record<string, unknown>;
    const insight = shortStr(x?.insight, 900);
    if (!Number.isInteger(x?.position) || !insight) return null;
    cards.push({ position: x.position as number, insight });
  }
  cards.sort((a, b) => a.position - b.position);
  if (cards.some((c, i) => c.position !== i)) return null;

  for (const c of cards) {
    const reversed = r.cards[c.position].reversed;
    if (reversed && UPRIGHT.test(c.insight) && !REVERSED.test(c.insight)) return null;
    if (!reversed && REVERSED.test(c.insight)) return null;
  }

  const texts = [synthesis, action, reflection, ...cards.map((c) => c.insight)];
  if (mentionsUndrawnCard(texts, r.cards.map((c) => c.id), !!r.chart)) return null;
  if (texts.some((t) => detectCrisis(t))) return null;
  return { cards, synthesis, action, reflection };
}
