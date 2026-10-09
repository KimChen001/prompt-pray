"use client";
// Birth chart (plan v0.2 §3.4; Figma: "Birth Chart / Desktop 1440" + "Mobile 390"): wheel, planets &
// points, chart interpretations (Library cards for the Big Three + the AI "Chart synthesis"), then the
// full natal report. Everything is calculated in the browser from the saved birth details.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { getBirth, getSettings, updateSettings, useStoreVersion } from "@/lib/store";
import { computeChart, type NatalChart, type SignCandidate } from "@/lib/astro/chart";
import type { BirthData } from "@/lib/astro/birth";
import { PLANET_NAME, PLANETS, SIGN_INFO, type Placement } from "@/lib/astro/zodiac";
import type { HouseSystem } from "@/lib/astro/houses";
import { SourceBadge } from "@/components/bits";
import { NatalReport, SynthesisCard, useNatalReport, wheelAspects } from "@/components/NatalReport";
import { ChartWheel } from "@/components/ChartWheel";
import { BirthMetaLine } from "@/components/BirthMeta";
import { TAGLINES, type BigThreeKind } from "@/components/BigThree";
import { learnHref } from "@/lib/learn";
import { ShareImage } from "@/components/ShareImage";
import { bigThreeCard } from "@/lib/share/content";

const GLYPH: Record<string, string> = { sun: "☉", moon: "☽", mercury: "☿", venus: "♀", mars: "♂", jupiter: "♃", saturn: "♄", uranus: "♅", neptune: "♆", pluto: "♇" };
const TEXT_STYLE = String.fromCharCode(0xfe0e);
const deg = (p: Placement) => `${p.degree}°${String(p.minute).padStart(2, "0")}′`;

export default function ChartPage() {
  const { m } = useI18n();
  const version = useStoreVersion();
  const [birth, setBirth] = useState<BirthData | null | undefined>(undefined);
  const [system, setSystem] = useState<HouseSystem>("placidus");

  useEffect(() => {
    setBirth(getBirth());
    setSystem(getSettings().houseSystem);
  }, [version]);

  const result = useMemo<{ chart: NatalChart } | { error: true } | null>(() => {
    if (!birth) return null;
    try {
      return { chart: computeChart(birth, system) };
    } catch {
      return { error: true };
    }
  }, [birth, system]);

  if (birth === undefined) return null;

  if (!birth) {
    return (
      <div className="form-page">
        <header className="page-head page-head-center">
          <p className="eyebrow">{m.chartPage.eyebrow}</p>
          <h1 className="h1">{m.chartPage.title}</h1>
          <p className="lede">{m.chart.empty}</p>
        </header>
        <Link href="/chart/edit" className="btn btn-primary btn-lg">{m.chart.add}</Link>
      </div>
    );
  }

  if (!result || "error" in result) {
    return (
      <div className="form-page">
        <h1 className="h1">{m.chartPage.title}</h1>
        <p className="notice">{m.chart.computeError} {birth.date} {birth.time ?? ""} · {birth.place.name} · {birth.place.tz}</p>
        <Link href="/chart/edit" className="btn btn-primary">{m.chart.edit}</Link>
      </div>
    );
  }

  return (
    <ChartView
      birth={birth}
      chart={result.chart}
      system={system}
      onSystem={(next) => {
        updateSettings({ houseSystem: next });
        setSystem(next);
      }}
    />
  );
}

function PlacementCard({ kind, title, c }: { kind: BigThreeKind; title: string; c: SignCandidate | null }) {
  const { m, fmt, pick } = useI18n();
  if (!c) {
    return (
      <article className="interp-card">
        <SourceBadge source="library" />
        <h3>{m.chartPage.risingLockedTitle} · {m.big3.locked}</h3>
        <p>{m.chartPage.timeOnly}</p>
        <Link href="/chart/edit" className="more">{m.big3.lockedHint} →</Link>
      </article>
    );
  }
  const sign = c.placement?.sign;
  const signName = sign ? pick(SIGN_INFO[sign].name) : fmt(m.big3.either, { a: pick(SIGN_INFO[c.options![0]].name), b: pick(SIGN_INFO[c.options![1]].name) });
  return (
    <article className="interp-card">
      <SourceBadge source="library" />
      <h3>{fmt(m.chartPage.inSign, { body: title, sign: signName })}</h3>
      <p>{sign ? pick(TAGLINES[kind][sign]) : fmt(m.big3.changesAt, { time: c.changesAt ?? "" })}</p>
      {sign && <Link href={learnHref("sign", sign)} className="more">{fmt(m.chartPage.learnMore, { sign: signName })} →</Link>}
    </article>
  );
}

function ChartView({ birth, chart, system, onSystem }: { birth: BirthData; chart: NatalChart; system: HouseSystem; onSystem: (s: HouseSystem) => void }) {
  const { m, pick, locale } = useI18n();
  const natal = useNatalReport(birth, chart, chart.houseSystem ?? system);
  const aspects = useMemo(() => wheelAspects(natal.nf), [natal.nf]);
  const approx = !chart.timeKnown;

  return (
    <div className="stack gap-48">
      <header className="page-head">
        <p className="eyebrow">{m.chartPage.eyebrow}</p>
        <h1 className="h1">{m.chartPage.title}</h1>
        <p className="lede">{m.chartPage.sub}</p>
        <BirthMetaLine birth={birth} chart={chart} />
        <div className="btn-row" style={{ marginTop: 4 }}>
          <Link href="/chart/reveal" className="btn-text" style={{ paddingLeft: 0 }}>{m.big3.title}</Link>
          <Link href="/chart/edit" className="btn-text">{m.chart.edit}</Link>
          <ShareImage filename="moona-big-three.png" build={() => bigThreeCard(chart, m, locale)} />
        </div>
      </header>

      <div className="chart-grid">
        <section className="chart-panel" aria-labelledby="wheel-title">
          <div className="chart-panel-head">
            <h2 className="eyebrow" id="wheel-title">{m.chartPage.wheel}</h2>
            {chart.timeKnown && (
              <div className="seg" role="group" aria-label={m.chart.houseSystem}>
                <button type="button" aria-pressed={system === "placidus"} onClick={() => onSystem("placidus")}>{m.chart.placidus}</button>
                <span className="seg-sep" aria-hidden="true">/</span>
                <button type="button" aria-pressed={system === "whole"} onClick={() => onSystem("whole")}>{m.chart.whole}</button>
              </div>
            )}
          </div>
          {chart.houseFallback && <p className="notice" style={{ margin: "0 0 12px" }}>{m.chart.houseFallback}</p>}
          <ChartWheel chart={chart} aspects={aspects} />
          {approx && <p className="muted small" style={{ margin: "12px 0 0" }}>{m.chartPage.timeOnly} {m.chart.noonNote}</p>}
        </section>

        <section className="chart-panel" aria-labelledby="points-title" style={{ overflowX: "auto" }}>
          <h2 className="eyebrow" id="points-title" style={{ marginBottom: 14 }}>{m.chartPage.points}</h2>
          <table className="planet-table">
            <thead>
              <tr>
                <th scope="col">{m.chartPage.planet}</th>
                <th scope="col">{m.chartPage.sign}</th>
                <th scope="col">{m.chartPage.degree}</th>
                <th scope="col">{m.chartPage.house}</th>
                <th scope="col"><abbr title={m.chart.retro} style={{ textDecoration: "none" }}>{m.chartPage.rx}</abbr></th>
              </tr>
            </thead>
            <tbody>
              {PLANETS.map((p) => {
                const pos = chart.positions[p];
                return (
                  <tr key={p}>
                    <th scope="row"><Link href={learnHref("planet", p)}><span aria-hidden="true">{GLYPH[p] + TEXT_STYLE} </span>{pick(PLANET_NAME[p])}</Link></th>
                    <td><Link href={learnHref("sign", pos.placement.sign)}>{pick(SIGN_INFO[pos.placement.sign].name)}</Link></td>
                    <td className="num">{approx ? "≈" : ""}{deg(pos.placement)}</td>
                    <td>{pos.house ? <Link href={learnHref("house", pos.house)}>{pos.house}</Link> : "–"}</td>
                    <td>{pos.retrograde ? "R" : "–"}</td>
                  </tr>
                );
              })}
              {chart.asc && chart.mc && (
                <>
                  <tr>
                    <th scope="row"><Link href={learnHref("house", 1)}>AC {m.chartPage.ascendant}</Link></th>
                    <td><Link href={learnHref("sign", chart.asc.sign)}>{pick(SIGN_INFO[chart.asc.sign].name)}</Link></td>
                    <td className="num">{deg(chart.asc)}</td>
                    <td>1</td>
                    <td>–</td>
                  </tr>
                  <tr>
                    <th scope="row"><Link href={learnHref("house", 10)}>MC {m.chartPage.midheaven}</Link></th>
                    <td><Link href={learnHref("sign", chart.mc.sign)}>{pick(SIGN_INFO[chart.mc.sign].name)}</Link></td>
                    <td className="num">{deg(chart.mc)}</td>
                    <td>{chart.houseSystem === "placidus" ? 10 : "–"}</td>
                    <td>–</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </section>
      </div>

      <section className="stack gap-16" aria-labelledby="interp-title">
        <h2 className="eyebrow" id="interp-title">{m.chartPage.interpretations}</h2>
        <div className="interp-grid">
          <PlacementCard kind="sun" title={m.chart.sun} c={chart.bigThree.sun} />
          <PlacementCard kind="moon" title={m.chart.moon} c={chart.bigThree.moon} />
          <PlacementCard kind="rising" title={m.chartPage.ascendant} c={chart.bigThree.rising} />
          <SynthesisCard natal={natal} />
        </div>
      </section>

      <NatalReport natal={natal} />

      <p className="muted small" style={{ margin: 0 }}>{m.chart.privacy} {m.chart.accuracy}</p>
    </div>
  );
}
