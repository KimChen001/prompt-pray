// What a conversation may send, built on this device from the person's choices. Chart context is
// the computed fact layer (placements, angles, aspects) — never birth date, time or place — and it
// keeps the unknown-birth-time rules (no Rising/houses, both candidate signs near a sign change).
import { computeChart } from "@/lib/astro/chart";
import { natalFacts, type NatalFact } from "@/lib/astro/natal-facts";
import type { BirthData } from "@/lib/astro/birth";
import type { HouseSystem } from "@/lib/astro/houses";
import type { MemoryNote } from "@/lib/memory";
import { MAX_NOTES_SENT } from "@/lib/memory";
import type { ChatContextChoice } from "./session";

const CHART_KINDS = new Set<NatalFact["kind"]>(["placement", "uncertainPlacement", "angle", "aspect"]);

export interface ChartContext {
  timeKnown: boolean;
  facts: NatalFact[];
}

/** The calculated chart facts a conversation may use (tight aspects only, to keep the prompt short). */
export function chartContext(birth: BirthData, houseSystem: HouseSystem): ChartContext {
  const chart = computeChart(birth, houseSystem);
  const nf = natalFacts(birth, chart);
  const facts = nf.facts.filter((f) => CHART_KINDS.has(f.kind) && (f.kind !== "aspect" || f.tight)).slice(0, 40);
  return { timeKnown: nf.timeKnown, facts };
}

export interface TalkBody {
  locale: "en" | "zh";
  messages: { role: "user" | "assistant"; content: string }[];
  chart?: ChartContext;
  today?: { date: string; timeZone: string };
  notes?: { id: string; text: string }[];
}

/** Notes this conversation shares: chosen ids that still exist and aren't paused, newest first. */
export function chosenNotes(choice: ChatContextChoice, notes: MemoryNote[]): MemoryNote[] {
  return notes.filter((n) => !n.paused && choice.noteIds.includes(n.id)).slice(0, MAX_NOTES_SENT);
}
