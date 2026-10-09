"use client";
// Tarot home: start with a question (main path), or pick a spread first; how a reading works; recent readings.
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { listReadings, useStoreVersion } from "@/lib/store";
import { SPREAD_ORDER, SPREADS } from "@/lib/tarot/spreads";
import { ReadingList } from "@/components/ReadingList";
import type { Reading } from "@/lib/tarot/types";

export default function TarotHome() {
  const { m, fmt, pick } = useI18n();
  const version = useStoreVersion();
  const [recent, setRecent] = useState<Reading[] | null>(null);
  useEffect(() => setRecent(listReadings().filter((r) => r.kind === "reading").slice(0, 5)), [version]);

  return (
    <div className="stack gap-48">
      <header className="page-head">
        <p className="eyebrow">{m.nav.tarot}</p>
        <h1 className="h1">{m.tarotHome.title}</h1>
        <p className="lede">{m.tarotHome.subtitle}</p>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <Link href="/tarot/new" className="btn btn-primary btn-lg">{m.home.start}</Link>
          <Link href="/today" className="btn btn-ghost">{m.daily.title}</Link>
        </div>
      </header>

      <section className="stack gap-16" aria-labelledby="how-title">
        <h2 className="eyebrow" id="how-title">{m.tarotHome.howTitle}</h2>
        <ol className="how-steps">
          {m.tarotHome.how.map((line, i) => (
            <li key={i}><span className="how-n">{String(i + 1).padStart(2, "0")}</span><span>{line}</span></li>
          ))}
        </ol>
      </section>

      <section className="stack gap-16" aria-labelledby="spreads-title">
        <h2 className="h2" id="spreads-title">{m.tarotHome.spreadsTitle}</h2>
        <div className="spread-grid">
          {SPREAD_ORDER.map((id) => (
            <Link key={id} href={`/tarot/new?spread=${id}`} className="spread-option" style={{ textDecoration: "none" }}>
              <span className="spread-diagram" aria-hidden="true">{Array.from({ length: SPREADS[id].count }, (_, i) => <i key={i} />)}</span>
              <span className="h3">{m.spreads[id].name}</span>
              <span className="muted small">{m.spreads[id].desc}</span>
              <span className="meta">{SPREADS[id].count === 1 ? m.spreads.card : fmt(m.spreads.cards, { n: SPREADS[id].count })} · {SPREADS[id].positions.map((p) => pick(p)).join(" · ")}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="stack gap-12" aria-labelledby="recent-title">
        <h2 className="h2" id="recent-title">{m.tarotHome.recent}</h2>
        {recent === null ? null : recent.length ? <ReadingList readings={recent} /> : <p className="muted">{m.tarotHome.none}</p>}
      </section>
    </div>
  );
}
