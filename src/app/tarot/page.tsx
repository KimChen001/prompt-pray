"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { listReadings, useStoreVersion } from "@/lib/store";
import { SPREAD_ORDER, SPREADS } from "@/lib/tarot/spreads";
import { ReadingList } from "@/components/ReadingList";
import type { Reading } from "@/lib/tarot/types";

export default function TarotHome() {
  const { m, fmt } = useI18n();
  const version = useStoreVersion();
  const [recent, setRecent] = useState<Reading[] | null>(null);
  useEffect(() => setRecent(listReadings().filter((r) => r.kind === "reading").slice(0, 5)), [version]);

  return (
    <div className="stack gap-32">
      <div className="stack gap-12">
        <h1 className="h1">{m.tarotHome.title}</h1>
        <p className="lede">{m.tarotHome.subtitle}</p>
        <div><Link href="/tarot/new" className="btn btn-primary">{m.tarotHome.start}</Link></div>
      </div>

      <div className="spread-grid">
        {SPREAD_ORDER.map((id) => (
          <Link key={id} href={`/tarot/new?spread=${id}`} className="spread-option" style={{ textDecoration: "none" }}>
            <span className="spread-diagram" aria-hidden="true">{Array.from({ length: SPREADS[id].count }, (_, i) => <i key={i} />)}</span>
            <span className="h3">{m.spreads[id].name}</span>
            <span className="muted small">{m.spreads[id].desc}</span>
            <span className="meta">{SPREADS[id].count === 1 ? m.spreads.card : fmt(m.spreads.cards, { n: SPREADS[id].count })}</span>
          </Link>
        ))}
      </div>

      <section className="stack gap-12">
        <h2 className="h2">{m.tarotHome.recent}</h2>
        {recent === null ? null : recent.length ? <ReadingList readings={recent} /> : <p className="muted">{m.tarotHome.none}</p>}
      </section>
    </div>
  );
}
