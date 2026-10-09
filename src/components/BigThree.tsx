"use client";
// Big Three cards (Figma: "Big Three Reveal", Card / Sun · Moon · Rising). The medallion uses the
// design's own assets in /public/design: three astrolabe rings, twelve ✧ marks and the original
// MOONA Sun / Moon / Rising glyphs, at the offsets from the Figma frame.
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import type { NatalChart, SignCandidate } from "@/lib/astro/chart";
import { SIGN_INFO, type Sign } from "@/lib/astro/zodiac";
import { learnHref } from "@/lib/learn";
import type { L10n } from "@/lib/tarot/types";
import taglinesJson from "../../content/astro/taglines.json";

export type BigThreeKind = "sun" | "moon" | "rising";
export const TAGLINES = taglinesJson as Record<BigThreeKind, Record<Sign, L10n>>;

// Glyph left offsets inside the 130px medallion, from the Figma cards (each glyph is drawn off-centre).
const GLYPH_LEFT: Record<BigThreeKind, number> = { sun: 38, moon: 31.5, rising: 40.5 };
const STARS = Array.from({ length: 12 }, (_, i) => {
  const a = (i * Math.PI) / 6;
  return { x: 65 + 44 * Math.cos(a), y: 65 + 44 * Math.sin(a) };
});

export function Medallion({ kind }: { kind: BigThreeKind }) {
  return (
    <div className="big3-medal" aria-hidden="true">
      <img className="ring-0" src="/design/astrolabe-ring-0.svg" alt="" width={130} height={130} />
      <img className="ring-1" src="/design/astrolabe-ring-1.svg" alt="" width={102} height={102} />
      <img className="ring-2" src="/design/astrolabe-ring-2.svg" alt="" width={74} height={74} />
      {STARS.map((s, i) => (
        <span key={i} className="star" style={{ left: s.x, top: s.y }}>✧</span>
      ))}
      <img className="glyph" src={`/design/glyph-${kind}.svg`} alt="" width={48} height={48} style={{ left: GLYPH_LEFT[kind], top: 45 }} />
    </div>
  );
}

const minutes = (deg: number, min: number) => `${deg}°${String(min).padStart(2, "0")}′`;

function Card({ kind, label, c, approximate }: { kind: BigThreeKind; label: string; c: SignCandidate | null; approximate: boolean }) {
  const { m, fmt, pick } = useI18n();
  if (!c) {
    return (
      <article className="big3-card" data-locked="true">
        <p className="eyebrow">{label}</p>
        <Medallion kind={kind} />
        <h2 className="big3-sign">{m.big3.locked}</h2>
        <p className="big3-line"><Link href="/chart/edit">{m.big3.lockedHint}</Link></p>
      </article>
    );
  }
  const sign = c.placement?.sign;
  return (
    <article className="big3-card">
      <p className="eyebrow">{label}</p>
      <Medallion kind={kind} />
      {sign ? (
        <>
          <h2 className="big3-sign"><Link href={learnHref("sign", sign)} style={{ textDecoration: "none" }}>{pick(SIGN_INFO[sign].name)}</Link></h2>
          <p className="big3-degree">{approximate ? "≈ " : ""}{minutes(c.placement!.degree, c.placement!.minute)}</p>
          <p className="big3-line">{pick(TAGLINES[kind][sign])}</p>
        </>
      ) : (
        <>
          <h2 className="big3-sign">{fmt(m.big3.either, { a: pick(SIGN_INFO[c.options![0]].name), b: pick(SIGN_INFO[c.options![1]].name) })}</h2>
          <p className="big3-line">{fmt(m.big3.changesAt, { time: c.changesAt ?? "" })}</p>
        </>
      )}
    </article>
  );
}

export function BigThreeCards({ chart }: { chart: NatalChart }) {
  const { m } = useI18n();
  const approx = !chart.timeKnown;
  return (
    <section className="big3" aria-label={m.big3.title}>
      <Card kind="sun" label={m.chart.sun} c={chart.bigThree.sun} approximate={approx} />
      <Card kind="moon" label={m.chart.moon} c={chart.bigThree.moon} approximate={approx} />
      <Card kind="rising" label={m.chart.rising} c={chart.bigThree.rising} approximate={false} />
    </section>
  );
}
