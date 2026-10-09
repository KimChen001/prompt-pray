// Interface line icons (navigation, tiles). Inline SVG drawn with currentColor at 1.5px, matching the
// zodiac/planet line style. Never Unicode symbols or emoji.
import type { SVGProps } from "react";

export type IconName = "home" | "today" | "tarot" | "chart" | "journal" | "talk" | "learn" | "match" | "whispers" | "about" | "menu" | "close" | "qr" | "motion" | "arrow" | "spark" | "phone";

const PATHS: Record<IconName, string> = {
  home: "M4 11.5 12 5l8 6.5M6.5 10v9h11v-9M10 19v-5h4v5",
  today: "M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  tarot: "M8.5 4.5h7a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1ZM12 9.2l.9 1.9 1.9.9-1.9.9-.9 1.9-.9-1.9-1.9-.9 1.9-.9.9-1.9ZM5 7v10.5M19 7v10.5",
  chart: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM3.5 12H7M17 12h3.5M12 3.5V7M12 17v3.5M6 6l2.5 2.5M15.5 15.5 18 18",
  journal: "M6.5 4.5h10a1 1 0 0 1 1 1v14l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3v-14a1 1 0 0 1 1-1ZM9 9h6M9 12.5h6",
  talk: "M5 6.5h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-7.5L7 20v-3.5H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1ZM8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01",
  learn: "M4 6.5c2.5-1 5.5-1 8 .8 2.5-1.8 5.5-1.8 8-.8v12c-2.5-1-5.5-1-8 .8-2.5-1.8-5.5-1.8-8-.8v-12ZM12 7.3v12",
  match: "M9 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM15 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z",
  whispers: "M12 4.5c-4.4 0-8 2.9-8 6.5 0 2 1.1 3.8 2.9 5L6 19.5l3.6-2c.8.2 1.6.3 2.4.3 4.4 0 8-2.9 8-6.5S16.4 4.5 12 4.5ZM12 8.3l.7 1.5 1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7.7-1.5Z",
  about: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 11v5.5M12 7.8h.01",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6 6 18",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM6.5 6.5h1v1h-1zM16.5 6.5h1v1h-1zM6.5 16.5h1v1h-1z",
  motion: "M3.5 12c2-4 4-4 6 0s4 4 6 0 3-3 5-1.5M3.5 17c2-2.5 4-2.5 6 0",
  arrow: "M5 12h14M13 6l6 6-6 6",
  spark: "M12 3.5l1.6 5.2 5.4 1.8-5.4 1.8L12 17.5l-1.6-5.2L5 10.5l5.4-1.8L12 3.5Z",
  phone: "M8 3.5h8a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1ZM11 17.5h2",
};

export function Icon({ name, size = 22, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}
