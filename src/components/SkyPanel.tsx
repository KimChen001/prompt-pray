"use client";
// Today's sky — functional build; visual design pending.
import { useMemo } from "react";
import { useI18n } from "@/lib/i18n";
import { skyForDay, type SkyEvent } from "@/lib/astro/sky";
import { PLANET_NAME, SIGN_INFO, type Sign } from "@/lib/astro/zodiac";
import { formatLocalDate, localDateKey } from "@/lib/time";
import { SourceBadge } from "./bits";

/** Moon disc lit according to the phase angle (0 = new, 180 = full), northern-hemisphere view. */
export function MoonIcon({ angle, size = 40 }: { angle: number; size?: number }) {
  const a = (((angle % 360) + 360) % 360) * (Math.PI / 180);
  const k = Math.cos(a); // +1 new … −1 full
  const waxing = angle % 360 < 180;
  const outer = waxing ? 1 : 0;
  const inner = waxing ? (k > 0 ? 0 : 1) : k > 0 ? 1 : 0;
  const rx = Math.max(0.01, Math.abs(k) * 10);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="var(--bg-2)" stroke="var(--line-strong)" />
      <path d={`M12 2 A10 10 0 0 ${outer} 12 22 A${rx.toFixed(2)} 10 0 0 ${inner} 12 2Z`} fill="var(--silver)" />
    </svg>
  );
}

export function SkyPanel({ localDate, timeZone, now }: { localDate: string; timeZone: string; now: Date }) {
  const { m, fmt, pick, locale } = useI18n();
  const sky = useMemo(() => skyForDay(localDate, timeZone, now), [localDate, timeZone, now]);

  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { hour: "numeric", minute: "2-digit", timeZone }),
    [locale, timeZone],
  );
  const sign = (s: Sign) => pick(SIGN_INFO[s].name);
  const describe = (e: SkyEvent) => {
    if (e.kind === "lunation") return fmt(m.sky.lunation, { phase: m.sky.phases[e.phase], sign: sign(e.sign) });
    return fmt(m.sky[e.kind], { planet: pick(PLANET_NAME[e.planet]), sign: sign(e.sign) });
  };

  return (
    <section className="panel stack gap-4" aria-labelledby="sky-title">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h2 className="h3" id="sky-title">{m.sky.title}</h2>
        <SourceBadge source="sky" />
      </div>

      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <MoonIcon angle={sky.moon.angle} />
        <div className="stack">
          <strong style={{ fontWeight: 500 }}>{fmt(m.sky.moonIn, { sign: sign(sky.moon.placement.sign) })} · {m.sky.phases[sky.moon.phase]}</strong>
          <span className="muted small">
            {fmt(m.sky.lit, { n: Math.round(sky.moon.illumination * 100) })} · {fmt(m.sky.sunIn, { sign: sign(sky.sun.sign) })}
          </span>
        </div>
      </div>

      <div className="stack gap-2">
        <span className="meta">{m.sky.events}</span>
        {sky.events.length ? (
          <ul className="list">
            {sky.events.map((e, i) => (
              <li key={i}>
                <span className="meta meta-raw" style={{ minWidth: 64 }}>{timeFmt.format(e.at)}</span>
                <span>{describe(e)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>{m.sky.noEvents}</p>
        )}
      </div>

      <div className="stack gap-2">
        <span className="meta">{m.sky.retrograde}</span>
        <p style={{ margin: 0 }}>
          {sky.retrograde.length ? sky.retrograde.map((p) => `${pick(PLANET_NAME[p])} ℞`).join(" · ") : <span className="muted">{m.sky.noneRetro}</span>}
        </p>
      </div>

      <div className="stack gap-1">
        {sky.next.map((n) => (
          <span key={n.phase} className="muted small">
            {fmt(m.sky.next, { phase: m.sky.phases[n.phase], when: `${formatLocalDate(localDateKey(n.at, timeZone), locale)} ${timeFmt.format(n.at)}` })} · {sign(n.sign)}
          </span>
        ))}
        <span className="muted small">{fmt(m.sky.timesLocal, { tz: timeZone })}</span>
      </div>
    </section>
  );
}
