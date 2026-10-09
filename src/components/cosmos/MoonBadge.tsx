"use client";
// Moon-phase badge, ported from the team's Figma Make prototype (Moona/src/app/App.tsx, MoonBadge).
// The prototype estimated the phase from a mean lunar month; this uses MOONA's real sky calculation
// (astronomy-engine, checked against Swiss Ephemeris) for the visitor's own day and time zone.
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { skyForDay, type PhaseName } from "@/lib/astro/sky";
import { SIGN_INFO } from "@/lib/astro/zodiac";
import { localDateKey, userTimeZone } from "@/lib/time";

interface MoonNow { phase: PhaseName; lit: number; waxing: boolean; sign: string }

export function MoonBadge() {
  const { m, pick } = useI18n();
  const [moon, setMoon] = useState<MoonNow | null>(null);

  useEffect(() => {
    const update = () => {
      try {
        const sky = skyForDay(localDateKey(), userTimeZone(), new Date());
        setMoon({ phase: sky.moon.phase, lit: sky.moon.illumination, waxing: sky.moon.angle < 180, sign: pick(SIGN_INFO[sky.moon.placement.sign].name) });
      } catch {
        setMoon(null);
      }
    };
    update();
    const t = window.setInterval(update, 10 * 60_000);
    return () => window.clearInterval(t);
  }, [pick]);

  if (!moon) return <span className="h-8 w-8" aria-hidden="true" />;
  const name = m.sky.phases[moon.phase];
  const pct = Math.round(moon.lit * 100);
  const r = 9;
  // terminator ellipse: rx shrinks to 0 at quarter, flips side past it
  const rx = Math.abs(1 - 2 * moon.lit) * r;
  const sweepOuter = moon.waxing ? 1 : 0;
  const sweepInner = moon.lit > 0.5 ? (moon.waxing ? 1 : 0) : moon.waxing ? 0 : 1;
  const path = `M10 1 A${r} ${r} 0 0 ${sweepOuter} 10 19 A${rx} ${r} 0 0 ${sweepInner} 10 1Z`;

  return (
    <div className="group relative">
      <Link href="/today" className="flex items-center gap-2.5 rounded-full py-1.5 pl-2 pr-3 text-white/55 no-underline transition-colors hover:text-white" aria-label={`${name}, ${m.cosmos.lit.replace("{n}", String(pct))}`}>
        <svg width="20" height="20" viewBox="0 0 20 20" className="drop-shadow-[0_0_6px_rgba(236,232,244,0.35)]" aria-hidden="true">
          <circle cx="10" cy="10" r={r} fill="rgba(236,232,244,0.08)" stroke="rgba(236,232,244,0.25)" strokeWidth="0.75" />
          <path d={path} fill="#ece8f4" />
        </svg>
        <span className="hidden text-[13px] sm:inline">{name}</span>
      </Link>
      <div className="pointer-events-none absolute right-0 top-full z-50 mt-2 w-64 translate-y-1 rounded-2xl border border-white/[0.08] bg-[#0d0b16]/90 p-4 opacity-0 backdrop-blur-xl transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <p className="font-serif-i text-xl leading-none">{name}</p>
        <p className="mt-1 font-mono-g text-[10px] uppercase tracking-[0.2em] text-white/45">{m.cosmos.lit.replace("{n}", String(pct))} · {m.sky.moonIn.replace("{sign}", moon.sign)}</p>
        <p className="mt-3 text-[13px] leading-relaxed text-white/65">{m.cosmos.phaseHints[moon.phase]}</p>
        <p className="mt-2 font-mono-g text-[9px] uppercase tracking-[0.2em] text-white/35">{m.badge.calc}</p>
      </div>
    </div>
  );
}
