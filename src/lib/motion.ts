"use client";
// Motion preference (design supplement §7): "auto" follows the system's reduced-motion setting,
// "reduced" shows still frames, "off" removes the animated nebula entirely (static orb only).
// Remembered on this device. An inline script in the layout copies it to <html data-motion> before
// first paint, so CSS can honour it without a flash.
import { useSyncExternalStore } from "react";
import { MOTION_KEY } from "./motion-boot";

export { MOTION_KEY };
export type MotionPref = "auto" | "reduced" | "off";
export type MotionLevel = "full" | "reduced" | "off";

const listeners = new Set<() => void>();

function readPref(): MotionPref {
  try {
    const v = window.localStorage.getItem(MOTION_KEY);
    return v === "reduced" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

function systemReduced(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// Used only when storage is blocked: the choice then lasts for this page view.
let memoryPref: MotionPref | null = null;
const currentPref = () => memoryPref ?? readPref();

export function setMotionPref(p: MotionPref): void {
  try {
    if (p === "auto") window.localStorage.removeItem(MOTION_KEY);
    else window.localStorage.setItem(MOTION_KEY, p);
    memoryPref = null;
  } catch {
    memoryPref = p;
  }
  document.documentElement.dataset.motion = levelFor(p);
  listeners.forEach((l) => l());
}

function levelFor(p: MotionPref): MotionLevel {
  if (p === "off") return "off";
  if (p === "reduced" || systemReduced()) return "reduced";
  return "full";
}

function subscribe(l: () => void) {
  listeners.add(l);
  const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const onChange = () => {
    document.documentElement.dataset.motion = levelFor(currentPref());
    l();
  };
  mq?.addEventListener?.("change", onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(l);
    mq?.removeEventListener?.("change", onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The person's choice ("auto" until they pick). Server render: "auto". */
export function useMotionPref(): MotionPref {
  return useSyncExternalStore(subscribe, currentPref, () => "auto");
}

/** What to actually do. Server render assumes "reduced" so nothing animates before hydration. */
export function useMotionLevel(): MotionLevel {
  return useSyncExternalStore(subscribe, () => levelFor(currentPref()), () => "reduced");
}
