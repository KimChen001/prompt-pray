// User-confirmed memory and in-site check-ins (combined review, "留存与记忆").
// A note exists only because the person saved it: either typed by them, or suggested by MOONA from
// their own words (with the quote it came from) and then confirmed. AI guesses are never saved.
// Check-ins are shown inside MOONA when the person comes back; nothing is pushed or emailed.

export const NOTE_MAX = 200;
export const MAX_NOTES = 50;
export const MAX_NOTES_SENT = 8;
export const CHECKIN_ACTION_MAX = 200;
export const CHECKIN_OUTCOME_MAX = 600;

export interface MemoryNote {
  id: string;
  text: string;
  /** "typed": written by the person. "suggested": proposed by MOONA from their words, then confirmed (maybe edited). */
  origin: "typed" | "suggested";
  /** For suggestions: the person's exact words the note came from. */
  quote?: string;
  /** The reading it came from; deleting that reading deletes the note. */
  readingId?: string;
  /** The conversation it came from; deleting that conversation deletes the note. */
  chatId?: string;
  createdAt: string;
  /** When the person confirmed (saved) it. Unconfirmed suggestions are never stored here. */
  confirmedAt: string;
  updatedAt: string;
  /** Withdrawn by the person: kept on the device but never offered to MOONA until they resume it. */
  paused?: boolean;
}

export interface CheckIn {
  id: string;
  readingId?: string;
  action: string;
  /** The person's local calendar day, YYYY-MM-DD. */
  dueDate: string;
  createdAt: string;
  status: "open" | "done" | "dropped";
  outcome?: string;
  closedAt?: string;
}

export interface NoteSuggestion {
  text: string;
  quote: string;
  status: "pending" | "saved" | "dismissed";
}

/** Adds days to a YYYY-MM-DD calendar date (no time zone involved). */
export function addDays(localDate: string, days: number): string {
  const [y, m, d] = localDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10); // a UTC-midnight instant: the ISO date is exactly the calendar date
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
export const validLocalDate = isDate;

/** Open check-ins due today or earlier (oldest first), and the number still upcoming. */
export function checkInsDue(list: CheckIn[], today: string): { due: CheckIn[]; upcoming: number } {
  const open = list.filter((c) => c.status === "open");
  return {
    due: open.filter((c) => c.dueDate <= today).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    upcoming: open.filter((c) => c.dueDate > today).length,
  };
}

/** Whitespace-, case- and width-insensitive form used to check that a quote is really the person's words. */
export const normalizeQuote = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

export function isQuoteOf(quote: string, said: string[]): boolean {
  const q = normalizeQuote(quote);
  return q.length >= 4 && said.some((s) => normalizeQuote(s).includes(q));
}

/** True when an equivalent note is already saved (so a suggestion isn't offered twice). */
export function hasSimilarNote(notes: MemoryNote[], text: string): boolean {
  const t = normalizeQuote(text);
  return notes.some((n) => normalizeQuote(n.text) === t);
}

// ---- calendar file (RFC 5545), generated on the device ----

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Folds content lines to 75 octets as RFC 5545 requires (UTF-8 aware). */
function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** An all-day calendar event on the check-in's date. The link points back to the reading on this site. */
export function checkInIcs(c: CheckIn, opts: { title: string; description: string; url?: string; now?: Date }): string {
  const day = c.dueDate.replace(/-/g, "");
  const next = addDays(c.dueDate, 1).replace(/-/g, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MOONA//Check-in//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${c.id}@moona`,
    `DTSTAMP:${stamp((opts.now ?? new Date()).toISOString())}`,
    `DTSTART;VALUE=DATE:${day}`,
    `DTEND;VALUE=DATE:${next}`,
    `SUMMARY:${esc(opts.title)}`,
    `DESCRIPTION:${esc(opts.description)}`,
    ...(opts.url ? [`URL:${opts.url}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
