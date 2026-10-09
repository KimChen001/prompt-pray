"use client";
// Device-local persistence. Everything here stays in this browser (plan v0.2 §4.4).
// Every access is wrapped: private windows and blocked storage must not break the app.
import { useSyncExternalStore } from "react";
import type { DrawnCard, Reading, Topic } from "@/lib/tarot/types";
import { guessHelpRegion, type HelpRegion } from "@/lib/safety";
import { userTimeZone } from "@/lib/time";
import type { BirthData } from "@/lib/astro/birth";
import type { HouseSystem } from "@/lib/astro/houses";
import type { Sign } from "@/lib/astro/zodiac";
import { keyString, type SavedNatalReport } from "@/lib/astro/natal-report";
import { MAX_NOTES, type CheckIn, type MemoryNote } from "@/lib/memory";

const KEYS = {
  settings: "moona.settings.v1",
  device: "moona.device.v1",
  readings: "moona.readings.v1",
  daily: "moona.daily.v1",
  birth: "moona.birth.v1",
  horoscope: "moona.horoscope.v2", // v2 adds generation metadata; v1 entries are ignored
  natal: "moona.natal.v1", // saved natal report versions (derived from birth details)
  notes: "moona.notes.v1", // notes the person confirmed ("what MOONA remembers")
  checkins: "moona.checkins.v1", // in-site check-ins
  favorites: "moona.favorites.v1", // saved Learn entries
} as const;

const MAX_READINGS = 100;
const MAX_NATAL_VERSIONS = 20;

export interface Settings {
  reversals: boolean;
  helpRegion: HelpRegion | "auto";
  houseSystem: HouseSystem;
  sunSign: Sign | null; // for the horoscope when there are no birth details
}

const DEFAULT_SETTINGS: Settings = { reversals: true, helpRegion: "auto", houseSystem: "placidus", sunSign: null };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  } finally {
    emit();
  }
}

export function storageAvailable(): boolean {
  try {
    const k = "moona.probe";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

// ---- change notifications for useSyncExternalStore ----
const listeners = new Set<() => void>();
let version = 0;
function emit() {
  version++;
  listeners.forEach((l) => l());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = () => emit();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
/** Re-render when local data changes; returns a counter usable as a memo dependency. */
export function useStoreVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => -1);
}

// ---- device id (never leaves the browser) ----
let memoryDeviceId: string | null = null;
export function getDeviceId(): string {
  const existing = read<string | null>(KEYS.device, null) ?? memoryDeviceId;
  if (existing) return existing;
  const id = crypto.randomUUID();
  if (!write(KEYS.device, id)) memoryDeviceId = id;
  return id;
}

// ---- settings ----
export function getSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...read<Partial<Settings>>(KEYS.settings, {}) };
}
export function updateSettings(patch: Partial<Settings>): void {
  write(KEYS.settings, { ...getSettings(), ...patch });
}
export function effectiveHelpRegion(settings: Settings): HelpRegion {
  return settings.helpRegion === "auto" ? guessHelpRegion(userTimeZone()) : settings.helpRegion;
}

// ---- readings history ----
export function listReadings(): Reading[] {
  return read<Reading[]>(KEYS.readings, []);
}
// If storage is blocked, readings from this tab are kept in memory so the result page still works.
const memoryReadings = new Map<string, Reading>();
export function getReading(id: string): Reading | null {
  return listReadings().find((r) => r.id === id) ?? memoryReadings.get(id) ?? null;
}
/** Returns false when the reading could only be kept in memory (history is off). */
export function saveReading(reading: Reading): boolean {
  memoryReadings.set(reading.id, reading);
  const rest = listReadings().filter((r) => r.id !== reading.id);
  return write(KEYS.readings, [reading, ...rest].slice(0, MAX_READINGS));
}
/** Deleting a reading also deletes the notes and check-ins that came from it. */
export function deleteReading(id: string): void {
  memoryReadings.delete(id);
  write(KEYS.readings, listReadings().filter((r) => r.id !== id));
  write(KEYS.notes, listNotes().filter((n) => n.readingId !== id));
  write(KEYS.checkins, listCheckIns().filter((c) => c.readingId !== id));
}

// ---- daily card (stored so a seen card never changes) ----
type DailyMap = Record<string, DrawnCard>;
const dailyKey = (localDate: string, topic: Topic) => `${localDate}|${topic}`;
export function getDaily(localDate: string, topic: Topic): DrawnCard | null {
  return read<DailyMap>(KEYS.daily, {})[dailyKey(localDate, topic)] ?? null;
}
export function saveDaily(localDate: string, topic: Topic, card: DrawnCard): void {
  const map = read<DailyMap>(KEYS.daily, {});
  // keep the last ~60 entries
  const entries = Object.entries({ ...map, [dailyKey(localDate, topic)]: card }).slice(-60);
  write(KEYS.daily, Object.fromEntries(entries));
}

// ---- birth details (never sent anywhere) ----
export function getBirth(): BirthData | null {
  return read<BirthData | null>(KEYS.birth, null);
}
export function saveBirth(birth: BirthData): boolean {
  return write(KEYS.birth, birth);
}
/** Removing birth details also removes everything derived from them (saved natal reports). */
export function clearBirth(): void {
  try {
    window.localStorage.removeItem(KEYS.birth);
    window.localStorage.removeItem(KEYS.natal);
  } catch {
    /* storage unavailable */
  }
  emit();
}

// ---- AI horoscope cache (one day's text per subject + language) ----
export interface CachedText {
  overall: string;
  love: string;
  work: string;
  /** When and by what the text was generated — shown so saved text is never labeled "live". */
  meta: { generatedAt: string; model: string; provider: string };
}
export function getCachedHoroscope(key: string): CachedText | null {
  return read<Record<string, CachedText>>(KEYS.horoscope, {})[key] ?? null;
}
export function cacheHoroscope(key: string, text: CachedText): void {
  const map = read<Record<string, CachedText>>(KEYS.horoscope, {});
  const entries = Object.entries({ ...map, [key]: text }).slice(-20);
  write(KEYS.horoscope, Object.fromEntries(entries));
}

// ---- natal report versions (newest first) ----
export function listNatalReports(): SavedNatalReport[] {
  return read<SavedNatalReport[]>(KEYS.natal, []);
}
export function saveNatalReport(report: SavedNatalReport): boolean {
  const id = keyString(report.key);
  const rest = listNatalReports().filter((r) => keyString(r.key) !== id);
  return write(KEYS.natal, [report, ...rest].slice(0, MAX_NATAL_VERSIONS));
}
export function deleteNatalReport(createdAt: string): void {
  write(KEYS.natal, listNatalReports().filter((r) => r.createdAt !== createdAt));
}

// ---- notes the person confirmed (newest first) ----
export function listNotes(): MemoryNote[] {
  return read<MemoryNote[]>(KEYS.notes, []);
}
export function saveNote(note: MemoryNote): boolean {
  const list = listNotes();
  return write(KEYS.notes, list.some((n) => n.id === note.id) ? list.map((n) => (n.id === note.id ? note : n)) : [note, ...list].slice(0, MAX_NOTES));
}
/** Deleting a note also removes it from every reading that shared it. */
export function deleteNote(id: string): void {
  write(KEYS.notes, listNotes().filter((n) => n.id !== id));
  const readings = listReadings();
  if (readings.some((r) => r.noteIds?.includes(id))) {
    write(KEYS.readings, readings.map((r) => (r.noteIds?.includes(id) ? { ...r, noteIds: r.noteIds.filter((x) => x !== id) } : r)));
  }
}

// ---- check-ins ----
export function listCheckIns(): CheckIn[] {
  return read<CheckIn[]>(KEYS.checkins, []);
}
export function saveCheckIn(c: CheckIn): boolean {
  const list = listCheckIns();
  return write(KEYS.checkins, list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [c, ...list].slice(0, 100));
}
export function deleteCheckIn(id: string): void {
  write(KEYS.checkins, listCheckIns().filter((c) => c.id !== id));
}

// ---- Learn favorites (newest first) ----
export interface Favorite {
  type: string;
  slug: string;
  savedAt: string;
}
export function listFavorites(): Favorite[] {
  return read<Favorite[]>(KEYS.favorites, []);
}
export function isFavorite(type: string, slug: string): boolean {
  return listFavorites().some((f) => f.type === type && f.slug === slug);
}
export function toggleFavorite(type: string, slug: string): boolean {
  const list = listFavorites();
  const on = !list.some((f) => f.type === type && f.slug === slug);
  write(KEYS.favorites, on ? [{ type, slug, savedAt: new Date().toISOString() }, ...list].slice(0, 300) : list.filter((f) => !(f.type === type && f.slug === slug)));
  return on;
}

// ---- export / wipe ----
export function exportLocalData(): string {
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), settings: getSettings(), birth: getBirth(), readings: listReadings(), daily: read(KEYS.daily, {}), natalReports: listNatalReports(), notes: listNotes(), checkIns: listCheckIns(), favorites: listFavorites() },
    null,
    2,
  );
}
export function clearLocalData(): void {
  try {
    Object.values(KEYS).forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* storage unavailable: nothing to clear */
  }
  emit();
}

