// "Welcome back", built only from what is saved on this device (design supplement §6, review §6.3):
// the time since the last visit, a check-in the person planned, their last reading or conversation.
// It never guesses what happened in their life; with nothing saved it says nothing personal.
// Pure function: the UI turns the result into words.
import type { CheckIn } from "@/lib/memory";
import type { Reading } from "@/lib/tarot/types";
import type { ChatSession } from "@/lib/chat/session";

export type Greeting =
  | { kind: "first" }
  | { kind: "checkin"; days: number | null; checkIn: CheckIn; more: number }
  | { kind: "reading"; days: number | null; reading: Reading }
  | { kind: "chat"; days: number | null; chat: ChatSession }
  | { kind: "back"; days: number | null };

/** Whole calendar days between two local dates "YYYY-MM-DD". */
export function daysBetween(fromLocal: string, toLocal: string): number {
  const t = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return Math.round((t(toLocal) - t(fromLocal)) / 86400e3);
}

export function greetingFor(input: {
  previousVisitLocal: string | null;
  todayLocal: string;
  dueCheckIns: CheckIn[];
  readings: Reading[];
  chats: ChatSession[];
}): Greeting {
  const { previousVisitLocal, todayLocal, dueCheckIns, readings, chats } = input;
  const days = previousVisitLocal ? Math.max(0, daysBetween(previousVisitLocal, todayLocal)) : null;
  const lastReading = readings.find((r) => r.kind === "reading");
  const lastChat = chats[0];
  if (dueCheckIns.length) return { kind: "checkin", days, checkIn: dueCheckIns[0], more: dueCheckIns.length - 1 };
  if (!previousVisitLocal && !lastReading && !lastChat) return { kind: "first" };
  const readingAt = lastReading?.createdAt ?? "";
  const chatAt = lastChat?.updatedAt ?? "";
  if (lastChat && chatAt > readingAt) return { kind: "chat", days, chat: lastChat };
  if (lastReading) return { kind: "reading", days, reading: lastReading };
  return { kind: "back", days };
}
