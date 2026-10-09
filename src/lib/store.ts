"use client";
// Device-local persistence. Everything here stays in this browser (plan v0.2 §4.4).
// Every access is wrapped: private windows and blocked storage must not break the app.
//
// Consistency rules (overall review §4–§5):
// - Records that already exist are changed only through patch functions that read the latest copy,
//   change the named fields, and write it back. A patch for a record that no longer exists does
//   nothing, so a late AI response can never bring back something the person deleted.
// - Deleting clears storage, the in-memory fallback copies and anything derived from the record.
// - `dataEpoch()` changes whenever the person clears data or removes birth details; async work
//   started before that compares epochs and drops its result.
import { useSyncExternalStore } from "react";
import type { ChatTurn, DrawnCard, Reading, Topic } from "@/lib/tarot/types";
import { guessHelpRegion, type HelpRegion } from "@/lib/safety";
import { userTimeZone } from "@/lib/time";
import type { BirthData } from "@/lib/astro/birth";
import type { HouseSystem } from "@/lib/astro/houses";
import type { Sign } from "@/lib/astro/zodiac";
import { keyString, type SavedNatalReport } from "@/lib/astro/natal-report";
import { MAX_NOTES, type CheckIn, type MemoryNote } from "@/lib/memory";
import type { MatchPerson, MatchResult } from "@/lib/astro/match";
import type { ChatSession } from "@/lib/chat/session";
import { MOTION_KEY } from "@/lib/motion-boot";

const KEYS = {
  settings: "moona.settings.v1",
  device: "moona.device.v1",
  readings: "moona.readings.v1",
  daily: "moona.daily.v1",
  birth: "moona.birth.v1",
  horoscope: "moona.horoscope.v3", // v3: keyed by a fingerprint of every calculation input + versions
  natal: "moona.natal.v1", // saved natal report versions (derived from birth details)
  notes: "moona.notes.v1", // notes the person confirmed ("what MOONA remembers")
  checkins: "moona.checkins.v1", // in-site check-ins
  favorites: "moona.favorites.v1", // saved Learn entries
  matches: "moona.matches.v1", // Match results, including the other person's birth details (device only)
  chats: "moona.chats.v1", // free conversations with MOONA
  visit: "moona.visit.v1", // last visit time, for an honest "welcome back"
  whispers: "moona.whispers.v1", // private Whispers entries (never leave the device)
} as const;
const LEGACY_KEYS = ["moona.horoscope.v2"];

const MAX_READINGS = 100;
const MAX_NATAL_VERSIONS = 20;
const MAX_CHATS = 40;

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

function remove(...keys: string[]) {
  try {
    keys.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* storage unavailable: nothing persisted */
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

// ---- epoch: async results started before a wipe are dropped ----
let epoch = 0;
export function dataEpoch(): number {
  return epoch;
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
/** Saves a new reading (or the daily card). Returns false when it could only be kept in memory. */
export function saveReading(reading: Reading): boolean {
  const rest = listReadings().filter((r) => r.id !== reading.id);
  const ok = write(KEYS.readings, [reading, ...rest].slice(0, MAX_READINGS));
  // The in-memory copy exists only while storage is blocked, so deletes can't miss it.
  if (ok) memoryReadings.delete(reading.id);
  else memoryReadings.set(reading.id, reading);
  return ok;
}
/**
 * Changes fields of an existing reading, starting from its latest saved copy. Returns the updated
 * reading, or null when it no longer exists (deleted or cleared): the change is dropped.
 */
export function patchReading(id: string, change: (latest: Reading) => Reading): Reading | null {
  const list = listReadings();
  const i = list.findIndex((r) => r.id === id);
  const latest = i >= 0 ? list[i] : memoryReadings.get(id);
  if (!latest) return null;
  const next = change(latest);
  if (i >= 0) {
    list[i] = next;
    write(KEYS.readings, list);
  } else {
    memoryReadings.set(id, next);
    emit();
  }
  return next;
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
  epoch++; // results computed for the previous details must not be saved under the new ones
  return write(KEYS.birth, birth);
}
/**
 * Removing birth details also removes everything derived from them: natal reports, the saved daily
 * horoscopes, matches computed from the profile (stored and in memory), and the chart from every
 * conversation's context.
 */
export function clearBirth(): void {
  epoch++;
  const keptMatches = listMatches().filter((x) => !x.a.fromProfile);
  for (const [id, x] of memoryMatches) if (x.a.fromProfile) memoryMatches.delete(id);
  remove(KEYS.birth, KEYS.natal, KEYS.horoscope, ...LEGACY_KEYS);
  try {
    window.localStorage.setItem(KEYS.matches, JSON.stringify(keptMatches));
  } catch {
    /* storage unavailable */
  }
  const chats = listChats();
  if (chats.some((c) => c.context.chart)) {
    try {
      window.localStorage.setItem(KEYS.chats, JSON.stringify(chats.map((c) => ({ ...c, context: { ...c.context, chart: false } }))));
    } catch {
      /* storage unavailable */
    }
  }
  for (const [id, c] of memoryChats) memoryChats.set(id, { ...c, context: { ...c.context, chart: false } });
  emit();
}

// ---- AI horoscope cache (one day's text per calculation fingerprint + language) ----
export interface CachedText {
  overall: string;
  love: string;
  work: string;
  /** When and by what the text was generated — shown so saved text is never labeled "live". */
  meta: { generatedAt: string; model: string; provider: string };
  /** The fact lines the text was written from, shown with the saved text. */
  basis?: string[];
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
/** Notes MOONA may use: confirmed and not paused. */
export function activeNotes(): MemoryNote[] {
  return listNotes().filter((n) => !n.paused);
}
export function saveNote(note: MemoryNote): boolean {
  const list = listNotes();
  return write(KEYS.notes, list.some((n) => n.id === note.id) ? list.map((n) => (n.id === note.id ? note : n)) : [note, ...list].slice(0, MAX_NOTES));
}
/** Deleting a note also removes it from every reading and conversation that shared it. */
export function deleteNote(id: string): void {
  write(KEYS.notes, listNotes().filter((n) => n.id !== id));
  const readings = listReadings();
  if (readings.some((r) => r.noteIds?.includes(id))) {
    write(KEYS.readings, readings.map((r) => (r.noteIds?.includes(id) ? { ...r, noteIds: r.noteIds.filter((x) => x !== id) } : r)));
  }
  for (const [rid, r] of memoryReadings) if (r.noteIds?.includes(id)) memoryReadings.set(rid, { ...r, noteIds: r.noteIds.filter((x) => x !== id) });
  const chats = listChats();
  if (chats.some((c) => c.context.noteIds.includes(id))) {
    write(KEYS.chats, chats.map((c) => (c.context.noteIds.includes(id) ? { ...c, context: { ...c.context, noteIds: c.context.noteIds.filter((x) => x !== id) } } : c)));
  }
  for (const [cid, c] of memoryChats) if (c.context.noteIds.includes(id)) memoryChats.set(cid, { ...c, context: { ...c.context, noteIds: c.context.noteIds.filter((x) => x !== id) } });
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

// ---- free conversations (newest first) ----
export function listChats(): ChatSession[] {
  const stored = read<ChatSession[]>(KEYS.chats, []);
  const extra = [...memoryChats.values()].filter((c) => !stored.some((s) => s.id === c.id));
  return [...extra, ...stored].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
const memoryChats = new Map<string, ChatSession>();
export function getChat(id: string): ChatSession | null {
  return read<ChatSession[]>(KEYS.chats, []).find((c) => c.id === id) ?? memoryChats.get(id) ?? null;
}
/** Creates a conversation. Returns false when it could only be kept in memory. */
export function createChat(c: ChatSession): boolean {
  const rest = read<ChatSession[]>(KEYS.chats, []).filter((x) => x.id !== c.id);
  const ok = write(KEYS.chats, [c, ...rest].slice(0, MAX_CHATS));
  if (ok) memoryChats.delete(c.id);
  else memoryChats.set(c.id, c);
  return ok;
}
/** Same contract as patchReading: null (and nothing written) when the conversation is gone. */
export function patchChat(id: string, change: (latest: ChatSession) => ChatSession): ChatSession | null {
  const list = read<ChatSession[]>(KEYS.chats, []);
  const i = list.findIndex((c) => c.id === id);
  const latest = i >= 0 ? list[i] : memoryChats.get(id);
  if (!latest) return null;
  const next = change(latest);
  if (i >= 0) {
    list[i] = next;
    write(KEYS.chats, list);
  } else {
    memoryChats.set(id, next);
    emit();
  }
  return next;
}
/** Deleting a conversation also deletes the notes saved from it. */
export function deleteChat(id: string): void {
  memoryChats.delete(id);
  write(KEYS.chats, read<ChatSession[]>(KEYS.chats, []).filter((c) => c.id !== id));
  write(KEYS.notes, listNotes().filter((n) => n.chatId !== id));
}

// ---- visits (for "welcome back" built only from real records) ----
export interface Visit {
  last: string;
  previous: string | null;
}
/** Records this visit; a new visit starts after 30 minutes away. Returns the previous visit, if any. */
export function recordVisit(now = new Date()): string | null {
  const v = read<Visit | null>(KEYS.visit, null);
  if (v && now.getTime() - new Date(v.last).getTime() < 30 * 60e3) {
    write(KEYS.visit, { ...v, last: now.toISOString() });
    return v.previous;
  }
  write(KEYS.visit, { last: now.toISOString(), previous: v?.last ?? null });
  return v?.last ?? null;
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

// ---- Match (newest first) ----
export interface SavedMatch {
  id: string;
  createdAt: string;
  /** "You": a reference to the saved birth details at the time, or details typed just for this match. */
  a: { fromProfile: true; name: string } | ({ fromProfile: false } & MatchPerson);
  b: MatchPerson;
  result: MatchResult;
}
export function listMatches(): SavedMatch[] {
  return read<SavedMatch[]>(KEYS.matches, []);
}
const memoryMatches = new Map<string, SavedMatch>();
export function getMatch(id: string): SavedMatch | null {
  return listMatches().find((x) => x.id === id) ?? memoryMatches.get(id) ?? null;
}
/** Returns false when the match could only be kept in memory (storage blocked). */
export function saveMatch(x: SavedMatch): boolean {
  const ok = write(KEYS.matches, [x, ...listMatches().filter((y) => y.id !== x.id)].slice(0, 50));
  if (ok) memoryMatches.delete(x.id);
  else memoryMatches.set(x.id, x);
  return ok;
}
export function deleteMatch(id: string): void {
  memoryMatches.delete(id);
  write(KEYS.matches, listMatches().filter((x) => x.id !== id));
}

// ---- private Whispers entries (device only) ----
export interface WhisperEntry {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}
export function listWhispers(): WhisperEntry[] {
  return read<WhisperEntry[]>(KEYS.whispers, []);
}
export function saveWhisper(w: WhisperEntry): boolean {
  const list = listWhispers();
  return write(KEYS.whispers, list.some((x) => x.id === w.id) ? list.map((x) => (x.id === w.id ? w : x)) : [w, ...list].slice(0, 200));
}
export function deleteWhisper(id: string): void {
  write(KEYS.whispers, listWhispers().filter((x) => x.id !== id));
}

// ---- export / wipe ----
export function exportLocalData(): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(), settings: getSettings(), birth: getBirth(), readings: listReadings(), daily: read(KEYS.daily, {}), natalReports: listNatalReports(),
      notes: listNotes(), checkIns: listCheckIns(), favorites: listFavorites(), matches: listMatches(), conversations: listChats(), whispers: listWhispers(),
    },
    null,
    2,
  );
}
/** Clears every MOONA key in storage and every in-memory copy kept for this tab. */
export function clearLocalData(): void {
  epoch++;
  remove(...Object.values(KEYS), ...LEGACY_KEYS, MOTION_KEY);
  memoryReadings.clear();
  memoryMatches.clear();
  memoryChats.clear();
  memoryDeviceId = null;
  emit();
}

/** Applies an assistant reply to a conversation thread only if the turn it answers is still there. */
export function appendReply(thread: ChatTurn[], answered: { at: string; content: string }, reply: ChatTurn): ChatTurn[] | null {
  const last = thread[thread.length - 1];
  if (!last || last.role !== "user" || last.at !== answered.at || last.content !== answered.content) return null;
  return [...thread, reply];
}
