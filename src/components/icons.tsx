// Thin-line icons (1.5px stroke) matching the silver line language of the logo.
import type { SVGProps } from "react";

const base: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

export const IconHome = () => (
  <svg {...base}><path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" /></svg>
);
export const IconToday = () => (
  <svg {...base}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
);
export const IconTarot = () => (
  <svg {...base}><rect x="6" y="3" width="12" height="18" rx="2" /><path d="M12 8l1.2 2.6 2.8.4-2 2 .5 2.8L12 14.5 9.5 15.8l.5-2.8-2-2 2.8-.4z" /></svg>
);
export const IconChart = () => (
  <svg {...base}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /></svg>
);
export const IconWhispers = () => (
  <svg {...base}><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4A8 8 0 1 1 20 12z" /><path d="M9 11h.01M12 11h.01M15 11h.01" /></svg>
);
export const IconMe = () => (
  <svg {...base}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
);
export const IconLearn = () => (
  <svg {...base}><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 19V5M9 7h6" /></svg>
);
export const IconMatch = () => (
  <svg {...base}><circle cx="9" cy="12" r="6" /><circle cx="15" cy="12" r="6" /></svg>
);
export const IconInfo = () => (
  <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
);
