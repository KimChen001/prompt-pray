"use client";
// Chart wheel in the Figma "Zodiac wheel panel" style. The rings, houses circle and zodiac glyphs are
// the design's own SVG assets (/public/design); everything placed by data is computed: the Ascendant
// sits at 9 o'clock, the zodiac runs counter-clockwise, house 1 starts at the Ascendant and the MC is
// at the top (standard chart convention; the Figma frame is an illustration with a fixed layout).
// Without a birth time there are no houses or angles and Aries 0° is placed at 9 o'clock.
import { useMemo } from "react";
import { useI18n } from "@/lib/i18n";
import type { NatalChart } from "@/lib/astro/chart";
import { PLANETS, PLANET_NAME, SIGNS, SIGN_INFO, type Planet } from "@/lib/astro/zodiac";
import type { Aspect } from "@/lib/astro/transits";

const SIZE = 558;
const C = SIZE / 2;
const PAD = 30;
const R = { ring0: 279, ring1: 265, ring2: 251, glyph: 238, houses: 225, houseNum: 206, planet: 174, tick: 216, hub: 112, label: 292 };
const GLYPH: Record<Planet, string> = { sun: "☉", moon: "☽", mercury: "☿", venus: "♀", mars: "♂", jupiter: "♃", saturn: "♄", uranus: "♅", neptune: "♆", pluto: "♇" };
const TEXT_STYLE = String.fromCharCode(0xfe0e); // force text (not emoji) presentation
const MIN_SEP = 8; // degrees between planet glyphs on the wheel

export interface WheelAspect {
  a: Planet;
  b: Planet;
  aspect: Aspect;
}

/** Screen position for an ecliptic longitude, with `base` (the Ascendant) at 9 o'clock. */
function at(lon: number, r: number, base: number) {
  const t = Math.PI + ((lon - base) * Math.PI) / 180;
  return { x: C + r * Math.cos(t), y: C - r * Math.sin(t) };
}

/** Spreads planets that would overlap, keeping their order around the wheel. */
function spread(lons: { p: Planet; lon: number }[]): Map<Planet, number> {
  const items = [...lons].sort((a, b) => a.lon - b.lon).map((x) => ({ ...x, d: x.lon }));
  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      const a = items[i], b = items[(i + 1) % items.length];
      let gap = b.d - a.d;
      if (i === items.length - 1) gap += 360;
      if (gap < MIN_SEP) {
        const push = (MIN_SEP - gap) / 2;
        a.d -= push;
        b.d += push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return new Map(items.map((x) => [x.p, x.d]));
}

export function ChartWheel({ chart, aspects }: { chart: NatalChart; aspects: WheelAspect[] }) {
  const { m, pick } = useI18n();
  const base = chart.asc?.lon ?? 0;
  const display = useMemo(() => spread(PLANETS.map((p) => ({ p, lon: chart.positions[p].lon }))), [chart]);
  const cusps = chart.cusps;

  return (
    <svg className="wheel" viewBox={`${-PAD} ${-PAD} ${SIZE + 2 * PAD} ${SIZE + 2 * PAD}`} role="img" aria-label={m.chartPage.wheelLabel}>
      <title>{m.chartPage.wheelLabel}</title>
      <image href="/design/wheel-ring-0.svg" x={0} y={0} width={558} height={558} />
      <image href="/design/wheel-ring-1.svg" x={14} y={14} width={530} height={530} />
      <image href="/design/wheel-ring-2.svg" x={28} y={28} width={502} height={502} />
      <image href="/design/wheel-houses.svg" x={54} y={54} width={450} height={450} />
      <circle cx={C} cy={C} r={R.hub} fill="none" stroke="#DDE1E8" strokeOpacity={0.16} />

      {/* sign boundaries (✧) and sign glyphs */}
      {SIGNS.map((s, i) => {
        const star = at(i * 30, R.ring1, base);
        const g = at(i * 30 + 15, R.glyph, base);
        return (
          <g key={s}>
            <text x={star.x} y={star.y} fontSize={11} fill="#A9AFBC" textAnchor="middle" dominantBaseline="central" style={{ fontFamily: "var(--font-ui)" }}>✧</text>
            <image href={`/design/zodiac/${s}.svg`} x={g.x - 14} y={g.y - 14} width={28} height={28}>
              <title>{pick(SIGN_INFO[s].name)}</title>
            </image>
          </g>
        );
      })}

      {/* houses */}
      {cusps?.map((lon, i) => {
        const a = at(lon, R.hub, base), b = at(lon, R.houses, base);
        const next = cusps[(i + 1) % 12];
        const mid = lon + ((((next - lon) % 360) + 360) % 360) / 2;
        const n = at(mid, R.houseNum, base);
        return (
          <g key={i}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#DDE1E8" strokeOpacity={0.3} />
            <text className="hn" x={n.x} y={n.y} fontSize={13} fill="#8A90A0" textAnchor="middle" dominantBaseline="central">{i + 1}</text>
          </g>
        );
      })}

      {/* angles */}
      {chart.asc && chart.mc && (
        <g>
          {[chart.asc.lon, chart.mc.lon].map((lon, i) => {
            const a = at(lon, R.ring0, base), b = at(lon + 180, R.ring0, base);
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#DDE1E8" strokeOpacity={0.22} />;
          })}
          {(() => {
            const ac = at(chart.asc.lon, R.label, base);
            const mc = at(chart.mc.lon, R.label, base);
            return (
              <>
                <text className="lbl" x={ac.x} y={ac.y} fontSize={12} fill="#ECEEF2" textAnchor="middle" dominantBaseline="central">AC</text>
                <text className="lbl" x={mc.x} y={mc.y} fontSize={12} fill="#ECEEF2" textAnchor="middle" dominantBaseline="central">MC</text>
              </>
            );
          })()}
        </g>
      )}

      {/* aspect lines between exact planet positions on the hub */}
      {aspects.filter((x) => x.aspect !== "conjunction").map((x) => {
        const a = at(chart.positions[x.a].lon, R.hub, base), b = at(chart.positions[x.b].lon, R.hub, base);
        const hard = x.aspect === "square" || x.aspect === "opposition";
        return <line key={`${x.a}-${x.b}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#DDE1E8" strokeOpacity={hard ? 0.32 : 0.5} strokeDasharray={hard ? "4 4" : undefined} />;
      })}

      {/* planets: exact tick on the houses circle, glyph spread to avoid overlaps */}
      {PLANETS.map((p) => {
        const lon = chart.positions[p].lon;
        const t1 = at(lon, R.houses, base), t2 = at(lon, R.tick, base);
        const g = at(display.get(p) ?? lon, R.planet, base);
        const hub = at(lon, R.hub, base);
        return (
          <g key={p}>
            <line x1={t1.x} y1={t1.y} x2={t2.x} y2={t2.y} stroke="#ECEEF2" strokeOpacity={0.8} />
            <circle cx={hub.x} cy={hub.y} r={2} fill="#DDE1E8" fillOpacity={0.7} />
            <text className="pg" x={g.x} y={g.y} fontSize={18} fill={p === "sun" ? "#D2B78C" : "#ECEEF2"} textAnchor="middle" dominantBaseline="central" style={{ fontFamily: "var(--font-ui)" }}>
              {GLYPH[p] + TEXT_STYLE}
              <title>{pick(PLANET_NAME[p])}</title>
            </text>
          </g>
        );
      })}
    </svg>
  );
}
