// Zodiac and planet symbols are always SVG line icons, never Unicode symbols: several of those
// (the zodiac signs U+2648–U+2653, Venus U+2640, Mars U+2642) turn into colour emoji on some
// platforms. Signs use the Figma zodiac vectors;
// planets use MOONA line icons in the same style (public/design/planets, placeholders until the
// design team supplies its own).
import type { Planet, Sign } from "@/lib/astro/zodiac";
import type { LearnEntry } from "@/lib/learn";

export function ZodiacIcon({ sign, size = 20, className }: { sign: Sign; size?: number; className?: string }) {
  return <img src={`/design/zodiac/${sign}.svg`} alt="" aria-hidden="true" width={size} height={size} className={className ? `astro-icon ${className}` : "astro-icon"} />;
}

export function PlanetIcon({ planet, size = 16, className }: { planet: Planet; size?: number; className?: string }) {
  return <img src={`/design/planets/${planet}.svg`} alt="" aria-hidden="true" width={size} height={size} className={className ? `astro-icon ${className}` : "astro-icon"} />;
}

/** The icon for a Learn entry: SVG for signs and planets; the plain-text symbol for aspects. */
export function EntryIcon({ entry, size = 18 }: { entry: LearnEntry; size?: number }) {
  if (entry.type === "sign") return <ZodiacIcon sign={entry.slug as Sign} size={size} />;
  if (entry.type === "planet") return <PlanetIcon planet={entry.slug as Planet} size={size} />;
  if (entry.glyph) return <span aria-hidden="true" style={{ fontSize: size * 0.9, lineHeight: 1 }}>{entry.glyph}</span>;
  return null;
}
