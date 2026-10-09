// Date semantics (plan v0.2 §4.1). A "LocalDate" is the user's calendar day in their own
// time zone. Never derive it from toISOString() (that is the UTC day) and never parse
// "YYYY-MM-DD" with new Date() (that is UTC midnight).

export type LocalDate = string; // "YYYY-MM-DD"

export function userTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Calendar day of `instant` as seen in `timeZone`. */
export function localDateKey(instant: Date = new Date(), timeZone: string = userTimeZone()): LocalDate {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function parseLocalDate(key: LocalDate): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`Invalid local date: ${key}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Human label for a LocalDate without converting it to an instant. */
export function formatLocalDate(key: LocalDate, locale: "en" | "zh"): string {
  const { year, month, day } = parseLocalDate(key);
  if (locale === "zh") return `${year}年${month}月${day}日`;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[month - 1]} ${day}, ${year}`;
}
