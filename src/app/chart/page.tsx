"use client";
// Natal chart (plan v0.2 §3.4). Functional build: data and states are final, visuals come later.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { getBirth, getSettings, updateSettings, useStoreVersion } from "@/lib/store";
import { computeChart, type NatalChart, type SignCandidate } from "@/lib/astro/chart";
import { formatOffset, zoneAbbreviation, type BirthData } from "@/lib/astro/birth";
import { formatPlacement, placement, PLANET_NAME, PLANETS, SIGN_INFO } from "@/lib/astro/zodiac";
import type { HouseSystem } from "@/lib/astro/houses";
import { formatLocalDate } from "@/lib/time";
import { SourceBadge } from "@/components/bits";

export default function ChartPage() {
  const { m, fmt, pick, locale } = useI18n();
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
      <div className="stack gap-16" style={{ maxWidth: 560 }}>
        <h1 className="h1">{m.chart.title}</h1>
        <p className="lede">{m.chart.empty}</p>
        <div><Link href="/chart/edit" className="btn btn-primary">{m.chart.add}</Link></div>
      </div>
    );
  }

  const placeName = [locale === "zh" && birth.place.zh ? birth.place.zh : birth.place.name, birth.place.admin1].filter(Boolean).join(", ");
  if (!result || "error" in result) {
    return (
      <div className="stack gap-16" style={{ maxWidth: 560 }}>
        <h1 className="h1">{m.chart.title}</h1>
        <p className="notice">{m.chart.computeError} {birth.date} {birth.time ?? ""} · {placeName} · {birth.place.tz}</p>
        <div><Link href="/chart/edit" className="btn btn-primary">{m.chart.edit}</Link></div>
      </div>
    );
  }

  const { chart } = result;
  const r = chart.resolved;
  const zone = r ? zoneAbbreviation(r.utc, birth.place.tz) : null;
  const bornLine = birth.time
    ? fmt(m.chart.born, { date: formatLocalDate(birth.date, locale), time: `${birth.time}${r ? ` (${zone ? `${zone}, ` : ""}${formatOffset(r.offset)})` : ""}`, place: placeName })
    : fmt(m.chart.bornNoTime, { date: formatLocalDate(birth.date, locale), place: placeName });

  const signName = (s: keyof typeof SIGN_INFO) => pick(SIGN_INFO[s].name);
  const candidate = (c: SignCandidate) =>
    c.placement ? formatPlacement(c.placement, locale) : c.options ? fmt(m.chart.or, { a: signName(c.options[0]), b: signName(c.options[1]) }) : "—";

  const big = [
    { key: "sun", label: m.chart.sun, desc: m.chart.sunDesc, c: chart.bigThree.sun },
    { key: "moon", label: m.chart.moon, desc: m.chart.moonDesc, c: chart.bigThree.moon },
    { key: "rising", label: m.chart.rising, desc: m.chart.risingDesc, c: chart.bigThree.rising },
  ];

  function changeSystem(next: HouseSystem) {
    updateSettings({ houseSystem: next });
    setSystem(next);
  }

  return (
    <div className="stack gap-32">
      <header className="stack gap-8">
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h1 className="h1">{m.chart.title}</h1>
          <SourceBadge source="calc" />
        </div>
        <p className="lede">{bornLine}</p>
        <div className="btn-row">
          <Link href="/chart/edit" className="btn btn-ghost">{m.chart.edit}</Link>
        </div>
      </header>

      <section className="stack gap-12">
        <h2 className="h2">{m.chart.bigThree}</h2>
        <div className="grid-tiles">
          {big.map(({ key, label, desc, c }) => (
            <div key={key} className="panel stack gap-8">
              <span className="meta">{label} · {desc}</span>
              {c ? (
                <>
                  <span className="h2">{candidate(c)}</span>
                  {c.changesAt && <span className="muted small">{fmt(m.chart.changesAt, { time: c.changesAt })}</span>}
                </>
              ) : (
                <>
                  <span className="h2" style={{ color: "var(--text-3)" }}>?</span>
                  <span className="muted small">{m.chart.risingLocked}</span>
                  <Link href="/chart/edit" className="btn-text" style={{ padding: 0, minHeight: 0, alignSelf: "flex-start" }}>{m.chart.edit}</Link>
                </>
              )}
            </div>
          ))}
        </div>
        {!chart.timeKnown && <p className="muted small" style={{ margin: 0 }}>{m.chart.noonNote}</p>}
      </section>

      <section className="stack gap-12">
        <h2 className="h2">{m.chart.planets}</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th scope="col">{m.chart.planet}</th><th scope="col">{m.chart.position}</th><th scope="col">{m.chart.house}</th><th scope="col"><span className="visually-hidden">{m.chart.retro}</span>℞</th></tr>
            </thead>
            <tbody>
              {PLANETS.map((p) => {
                const pos = chart.positions[p];
                return (
                  <tr key={p}>
                    <th scope="row">{pick(PLANET_NAME[p])}</th>
                    <td>{formatPlacement(pos.placement, locale)}</td>
                    <td>{pos.house ?? "—"}</td>
                    <td>{pos.retrograde ? <abbr title={m.chart.retro}>℞</abbr> : ""}</td>
                  </tr>
                );
              })}
              {chart.asc && chart.mc && (
                <>
                  <tr><th scope="row">{pick(PLANET_NAME.asc)}</th><td>{formatPlacement(chart.asc, locale)}</td><td>1</td><td /></tr>
                  <tr><th scope="row">{pick(PLANET_NAME.mc)}</th><td>{formatPlacement(chart.mc, locale)}</td><td>{chart.houseSystem === "placidus" ? 10 : "—"}</td><td /></tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack gap-12">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <h2 className="h2">{m.chart.houses}</h2>
          {chart.timeKnown && (
            <div className="btn-row" role="group" aria-label={m.chart.houseSystem}>
              <button type="button" className="chip" aria-pressed={system === "placidus"} onClick={() => changeSystem("placidus")}>{m.chart.placidus}</button>
              <button type="button" className="chip" aria-pressed={system === "whole"} onClick={() => changeSystem("whole")}>{m.chart.whole}</button>
            </div>
          )}
        </div>
        {chart.houseFallback && <p className="notice" style={{ margin: 0 }}>{m.chart.houseFallback}</p>}
        {chart.cusps ? (
          <ol className="cusps">
            {chart.cusps.map((c, i) => (
              <li key={i}><span className="meta">{i + 1}</span> {formatPlacement(placement(c), locale)}</li>
            ))}
          </ol>
        ) : (
          <p className="muted" style={{ margin: 0 }}>{m.chart.noHouses}</p>
        )}
      </section>

      <section className="panel stack gap-8">
        <SourceBadge source="dev" />
        <h2 className="h3">{m.chart.interpretTitle}</h2>
        <p className="muted small" style={{ margin: 0 }}>{m.chart.interpretDev}</p>
      </section>

      <p className="muted small" style={{ margin: 0 }}>{m.chart.privacy} {m.chart.accuracy}</p>
    </div>
  );
}

