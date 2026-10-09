// Shared by the client motion module and the server layout (a "use client" module can't export plain values to a server component).
export const MOTION_KEY = "moona.motion.v1";

/** Runs before first paint (inlined in the root layout). Keep it tiny and dependency-free. */
export const MOTION_BOOT_SCRIPT = `try{var p=localStorage.getItem("${MOTION_KEY}");var r=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;document.documentElement.dataset.motion=p==="off"?"off":(p==="reduced"||r)?"reduced":"full"}catch(e){}`;
