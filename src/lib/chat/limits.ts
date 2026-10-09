// One message-length contract for every conversation (overall review §2), shared by the browser and
// the API so the browser never sends what the server will refuse:
// - What the person types is capped at USER_MAX; consecutive messages of theirs (after a failed
//   send) are merged into one turn of at most USER_MERGED_MAX.
// - A reply the server accepted is at most ASSISTANT_MAX, so it can always be sent back as history.
// - History is trimmed from the oldest end on whole messages, always starts with the person's
//   message and ends with their newest one.
import type { ChatMessage } from "@/lib/ai/types";

export const CHAT_LIMITS = {
  userMax: 800,
  userMergedMax: 2000,
  assistantMax: 1500,
  maxMessages: 16,
  maxTotalChars: 12_000,
} as const;

/** Merges same-role neighbours, caps lengths, keeps the newest messages that fit, starting with the person. */
export function windowMessages(turns: { role: "user" | "assistant"; content: string }[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const t of turns) {
    const content = t.content.trim();
    if (!content) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.role === t.role) prev.content = `${prev.content}\n\n${content}`;
    else merged.push({ role: t.role, content });
  }
  for (const m of merged) {
    const max = m.role === "user" ? CHAT_LIMITS.userMergedMax : CHAT_LIMITS.assistantMax;
    // Keep the newest words of a long merged message; a reply is cut at the end.
    if (m.content.length > max) m.content = m.role === "user" ? m.content.slice(-max) : m.content.slice(0, max);
  }
  const out: ChatMessage[] = [];
  let total = 0;
  for (let i = merged.length - 1; i >= 0; i--) {
    const m = merged[i];
    if (out.length >= CHAT_LIMITS.maxMessages || total + m.content.length > CHAT_LIMITS.maxTotalChars) break;
    out.unshift(m);
    total += m.content.length;
  }
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length || out[out.length - 1].role !== "user") return [];
  return out;
}

/** Server side: null unless the messages follow the contract above. */
export function parseMessages(v: unknown): ChatMessage[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > CHAT_LIMITS.maxMessages) return null;
  const messages: ChatMessage[] = [];
  let total = 0;
  for (const m of v as unknown[]) {
    const x = m as Record<string, unknown>;
    if ((x?.role !== "user" && x?.role !== "assistant") || typeof x.content !== "string") return null;
    const content = x.content.trim();
    const max = x.role === "user" ? CHAT_LIMITS.userMergedMax : CHAT_LIMITS.assistantMax;
    if (!content || content.length > max) return null;
    total += content.length;
    messages.push({ role: x.role, content });
  }
  if (total > CHAT_LIMITS.maxTotalChars) return null;
  if (messages[0].role !== "user" || messages[messages.length - 1].role !== "user") return null;
  return messages;
}
