// Free conversations with MOONA ("Talk"). Stored only on this device. The person chooses, per
// conversation, what MOONA may use: their chart (calculated placements), today's sky (calculated),
// and which of their saved notes (things they said and confirmed). Pure helpers, unit-tested.
import type { ChatTurn } from "@/lib/tarot/types";

export interface ChatContextChoice {
  chart: boolean;
  today: boolean;
  noteIds: string[];
}

export interface ChatSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** The person's first message, shortened: their own words, nothing inferred. */
  title: string;
  context: ChatContextChoice;
  turns: ChatTurn[];
}

export const TITLE_MAX = 64;

export function sessionTitle(firstMessage: string): string {
  const line = firstMessage.trim().split(/\r?\n/)[0].replace(/\s+/g, " ");
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

export function newSession(id: string, first: string, context: ChatContextChoice, now = new Date()): ChatSession {
  const at = now.toISOString();
  return { id, createdAt: at, updatedAt: at, title: sessionTitle(first), context, turns: [{ role: "user", content: first.trim(), at }] };
}

/** The newest turn is the person's and has no reply yet (a send failed or is in flight). */
export function awaitingReply(s: Pick<ChatSession, "turns">): boolean {
  const last = s.turns[s.turns.length - 1];
  return !!last && last.role === "user";
}
