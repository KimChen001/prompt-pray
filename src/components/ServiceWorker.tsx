"use client";
// Registers /sw.js in production builds only, so `next dev` (and its hot reload) is never cached.
import { useEffect } from "react";

export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const v = encodeURIComponent(process.env.NEXT_PUBLIC_BUILD_ID ?? "dev");
    navigator.serviceWorker.register(`/sw.js?v=${v}`, { scope: "/" }).catch(() => undefined);
  }, []);
  return null;
}
