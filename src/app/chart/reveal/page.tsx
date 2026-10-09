"use client";
// Big Three reveal (Figma: "Big Three Reveal / Desktop 1440" + "Mobile 390"), shown right after the
// birth details are saved. Everything is calculated in the browser from the saved details.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { getBirth, getSettings, useStoreVersion } from "@/lib/store";
import { computeChart } from "@/lib/astro/chart";
import type { BirthData } from "@/lib/astro/birth";
import { BigThreeCards } from "@/components/BigThree";
import { BirthMetaLine } from "@/components/BirthMeta";

export default function BigThreeRevealPage() {
  const { m } = useI18n();
  const version = useStoreVersion();
  const [birth, setBirth] = useState<BirthData | null | undefined>(undefined);
  useEffect(() => setBirth(getBirth()), [version]);
  const chart = useMemo(() => {
    if (!birth) return null;
    try {
      return computeChart(birth, getSettings().houseSystem);
    } catch {
      return null;
    }
  }, [birth]);

  if (birth === undefined) return null;
  if (!birth || !chart) {
    return (
      <div className="form-page">
        <header className="page-head page-head-center">
          <p className="eyebrow">{m.big3.eyebrow}</p>
          <h1 className="h1">{m.big3.title}</h1>
          <p className="lede">{m.chart.empty}</p>
        </header>
        <Link href="/chart/edit" className="btn btn-primary btn-lg">{m.chart.add}</Link>
      </div>
    );
  }

  return (
    <div className="stack gap-48">
      <header className="page-head">
        <p className="eyebrow">{m.big3.eyebrow}</p>
        <h1 className="h1">{m.big3.title}</h1>
        <p className="lede">{m.big3.sub}</p>
        <BirthMetaLine birth={birth} chart={chart} />
      </header>

      <BigThreeCards chart={chart} />

      {!chart.timeKnown && (
        <section className="stack gap-12">
          <hr className="hairline" />
          <p className="eyebrow">{m.big3.unknownTitle}</p>
          <p className="muted" style={{ margin: 0, fontSize: 15 }}>{m.big3.unknownBody}</p>
        </section>
      )}

      <div className="btn-row" style={{ justifyContent: "center" }}>
        <Link href="/chart" className="btn btn-primary btn-lg">{m.big3.seeChart} <span aria-hidden="true">→</span></Link>
        <Link href="/chart/edit" className="btn-text">{m.big3.edit}</Link>
      </div>
    </div>
  );
}
