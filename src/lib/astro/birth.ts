// Birth moment = local wall-clock time in the birthplace's IANA zone → UTC instant
// (plan v0.2 §3.1, §4.1). Uses the browser's ICU time-zone history, including past DST rules.
import { parseLocalDate, type LocalDate } from "@/lib/time";

export interface BirthPlace {
  name: string;
  admin1?: string;
  country: string; // ISO 3166-1 alpha-2
  lat: number;
  lon: number; // east positive
  tz: string; // IANA zone
  zh?: string | null; // Chinese name, when GeoNames has one
}

export interface BirthData {
  date: LocalDate;
  time: string | null; // "HH:MM", null when unknown
  place: BirthPlace;
  /** Chosen when the local time happened twice (DST fall-back): offset in minutes east of UTC. */
  offsetChoice?: number;
}

export interface ResolvedTime {
  utc: Date;
  offset: number; // minutes east of UTC
}

export type Resolution =
  | { status: "ok"; result: ResolvedTime }
  | { status: "ambiguous"; options: ResolvedTime[] } // earlier instant first
  | { status: "nonexistent"; suggestion: ResolvedTime; suggestedTime: string };

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** UTC offset (minutes east) in force in `tz` at `instantMs`. */
export function offsetAt(instantMs: number, tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(new Date(instantMs))
    .find((p) => p.type === "timeZoneName")!.value; // "GMT", "GMT-04:00", "GMT+05:30", "GMT-04:56:02"
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?/.exec(name);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0) + Number(m[4] ?? 0) / 60);
}

export function parseTime(time: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Invalid time: ${time}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Every UTC instant whose wall-clock time in `tz` is date+time. 0 = gap, 2 = overlap. */
export function resolveLocal(date: LocalDate, time: string, tz: string): Resolution {
  const { year, month, day } = parseLocalDate(date);
  const { hour, minute } = parseTime(time);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set([-1, 0, 1].map((d) => offsetAt(naive + d * 86400e3, tz)));
  const options: ResolvedTime[] = [];
  for (const offset of offsets) {
    const utcMs = naive - offset * 60e3;
    if (offsetAt(utcMs, tz) === offset && !options.some((o) => o.utc.getTime() === utcMs)) {
      options.push({ utc: new Date(utcMs), offset });
    }
  }
  options.sort((a, b) => a.utc.getTime() - b.utc.getTime());
  if (options.length === 1) return { status: "ok", result: options[0] };
  if (options.length > 1) return { status: "ambiguous", options };
  // In a spring-forward gap: use the offset in force just after the gap; the wall time shifts later.
  const after = offsetAt(naive + 86400e3, tz);
  const before = offsetAt(naive - 86400e3, tz);
  const utcMs = naive - before * 60e3;
  const suggestion = { utc: new Date(utcMs), offset: after };
  return { status: "nonexistent", suggestion, suggestedTime: localTimeIn(utcMs, tz) };
}

/** "HH:MM" wall-clock time of an instant in `tz`. */
export function localTimeIn(instantMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instantMs));
}

/** "UTC−4", "UTC+5:30", "UTC" */
export function formatOffset(offset: number): string {
  if (offset === 0) return "UTC";
  const sign = offset < 0 ? "−" : "+";
  const abs = Math.abs(offset);
  const h = Math.floor(abs / 60);
  const m = Math.round(abs % 60);
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** Short zone name such as "EDT" where the locale has one; otherwise null. */
export function zoneAbbreviation(instant: Date, tz: string): string | null {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value;
  return name && !/^GMT|^UTC/.test(name) ? name : null;
}

/** The instant used for the chart: the resolved birth time, honoring the user's choice when ambiguous. */
export function birthInstant(b: BirthData): ResolvedTime | null {
  if (!b.time) return null;
  const r = resolveLocal(b.date, b.time, b.place.tz);
  if (r.status === "ok") return r.result;
  if (r.status === "ambiguous") return r.options.find((o) => o.offset === b.offsetChoice) ?? r.options[0];
  return r.suggestion;
}
