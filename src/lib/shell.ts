"use client";
// Offline support for dynamic routes. The service worker caches one "shell" copy of
// /tarot/r/[id], /match/r/[id] and /learn/[type]/[slug] (with the segment "_shell") and serves it for
// any URL of that route that isn't cached. These pages render from device data, so the shell only
// needs the real segment, which it reads from the address bar after hydration.
import { useEffect, useState } from "react";

export const SHELL_SEGMENT = "_shell";

/** The route segment at `index` (0-based, after the leading slash); null until known. */
export function useRouteSegment(value: string, index: number): string | null {
  const isShell = value === SHELL_SEGMENT;
  const [real, setReal] = useState<string | null>(null);
  useEffect(() => {
    if (!isShell) return;
    const seg = window.location.pathname.split("/").filter(Boolean)[index];
    setReal(seg ? decodeURIComponent(seg) : null);
  }, [isShell, index]);
  return isShell ? real : value;
}
