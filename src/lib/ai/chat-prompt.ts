// Follow-up conversation about a saved tarot reading. The reading's cards are rebuilt server-side
// from ids; the model may not draw, add or swap cards, and must not invent facts about the person.
import { detectCrisis } from "@/lib/safety";
import { isQuoteOf, normalizeQuote, NOTE_MAX } from "@/lib/memory";
import { mentionsUndrawnCard, parseTarotRequest, tarotPrompt, type TarotRequest } from "./tarot-prompt";
import type { ChatMessage, JsonSchema } from "./types";

const MAX_TURNS = 12;
const MAX_TURN_LEN = 800;

export interface ChatRequest {
  locale: "en" | "zh";
  reading: TarotRequest;
  /** The interpretation text the user saw (AI or offline), so replies stay consistent with it. */
  shown?: string;
  messages: ChatMessage[];
}

export const CHAT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    reply: { type: "string" },
    // At most one note MOONA offers to remember. It is only a suggestion: the person decides.
    remember: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, quote: { type: "string" } },
        required: ["text", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["reply", "remember"],
  additionalProperties: false,
};

export interface ChatReply {
  reply: string;
  /** A validated suggestion, grounded in the person's own words in this request; null if none. */
  remember: { text: string; quote: string } | null;
}

export function parseChatRequest(body: unknown): ChatRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const reading = parseTarotRequest(b.reading);
  if (!reading) return null;
  if (!Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length > MAX_TURNS) return null;
  const messages: ChatMessage[] = [];
  for (const m of b.messages as unknown[]) {
    const x = m as Record<string, unknown>;
    if ((x?.role !== "user" && x?.role !== "assistant") || typeof x.content !== "string" || !x.content.trim() || x.content.length > MAX_TURN_LEN) return null;
    messages.push({ role: x.role, content: x.content.trim() });
  }
  if (messages[messages.length - 1].role !== "user" || messages[0].role !== "user") return null;
  const shown = typeof b.shown === "string" && b.shown.length <= 4000 ? b.shown : undefined;
  return { locale: reading.locale, reading, shown, messages };
}

/** The latest user turn (or a shared note) signals a crisis: answer with support resources, not a reading. */
export function chatNeedsSupport(r: ChatRequest): boolean {
  return detectCrisis(r.messages[r.messages.length - 1].content) || (r.reading.notes ?? []).some(detectCrisis);
}

export function chatPrompt(r: ChatRequest): { system: string; messages: ChatMessage[] } {
  const base = tarotPrompt(r.reading);
  const language = r.locale === "zh" ? "Simplified Chinese" : "English";
  const system = [
    "You are MOONA, continuing a conversation about ONE tarot reading that is already drawn.",
    "Do not draw new cards, add cards, swap cards or change orientations. Refer only to the cards listed below.",
    "When the person adds new information, update the emphasis and quote or paraphrase what they said; keep their words distinct from what the cards symbolize.",
    "Do not invent facts about their life. If something is a guess, say so. Tarot is reflection, not prediction.",
    "Never give medical, legal or financial instructions. Never predict illness, death or pregnancy.",
    "Reply in 2–5 sentences. Ask at most one question back.",
    "If saved notes conflict with what the person says now, trust what they say now; you may ask once whether the note still holds.",
    "remember: usually empty. Add one item only when the person states a concrete, lasting fact about their situation that would help a later reading (e.g. 'Weighing two job offers: stability vs. growth'). text = a short neutral note in their terms (under 120 characters); quote = their exact words from this conversation that it comes from. Never infer feelings, traits or motives they did not state, and never repeat a saved note.",
    `Write in ${language}. Return JSON with reply and remember.`,
    "",
    "The reading:",
    base.user,
    r.shown ? `\nWhat the person was shown:\n${r.shown}` : "",
  ].join("\n");
  return { system, messages: r.messages };
}

export function validateChat(data: unknown, r: ChatRequest): ChatReply | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const reply = d.reply;
  if (typeof reply !== "string" || !reply.trim() || reply.length > 1500) return null;
  if (mentionsUndrawnCard([reply], r.reading.cards.map((c) => c.id), !!r.reading.chart)) return null;
  if (detectCrisis(reply)) return null;
  return { reply: reply.trim(), remember: validSuggestion(d.remember, r) };
}

/**
 * Keeps the first suggestion whose quote really is the person's words in this request (not the
 * model's, not a saved note) and whose text is a short, safe note that isn't already saved.
 * An unusable suggestion is dropped; it never fails the reply.
 */
function validSuggestion(v: unknown, r: ChatRequest): ChatReply["remember"] {
  if (!Array.isArray(v)) return null;
  const said = r.messages.filter((m) => m.role === "user").map((m) => m.content);
  const saved = (r.reading.notes ?? []).map(normalizeQuote);
  for (const item of v.slice(0, 3)) {
    const x = item as Record<string, unknown>;
    if (typeof x?.text !== "string" || typeof x.quote !== "string") continue;
    const text = x.text.trim(), quote = x.quote.trim();
    if (text.length < 3 || text.length > NOTE_MAX || quote.length > 400) continue;
    if (!isQuoteOf(quote, said) || saved.includes(normalizeQuote(text))) continue;
    if (detectCrisis(text) || mentionsUndrawnCard([text], r.reading.cards.map((c) => c.id), !!r.reading.chart)) continue;
    return { text, quote };
  }
  return null;
}
