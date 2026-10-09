"use client";
// Device-local persistence. Everything here stays in this browser (plan v0.2 §4.4).
// Every access is wrapped: private windows and blocked storage must not break the app.
import { useSyncExternalStore } from "react";
import type { DrawnCard, Reading, Topic } from "@/lib/tarot/types";
import { guessHelpRegion, type HelpRegion } from "@/lib/safety";
import { userTimeZone } from "@/lib/time";

const KEYS = {
  settings: "moona.settings.v1",
  device: "moona.device.v1",
  readings: "moona.readings.v1",
  daily: "moona.daily.v1",
} as const;

const MAX_READINGS = 100;

export interface Settings {
  reversals: boolean;
  helpRegion: HelpRegion | "auto";
}

const DEFAULT_SETTINGS: Settings = { reversals: true, helpRegion: "auto" };

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
export function deleteReading(id: string): void {
  write(KEYS.readings, listReadings().filter((r) => r.id !== id));
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

// ---- export / wipe ----
export function exportLocalData(): string {
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), settings: getSettings(), readings: listReadings(), daily: read(KEYS.daily, {}) },
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

