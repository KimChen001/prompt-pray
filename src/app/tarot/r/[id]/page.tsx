"use client";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { getReading } from "@/lib/store";
import { analyze, type Analysis } from "@/lib/tarot/engine";
import { getCard, hasCard } from "@/lib/tarot/deck";
import { SPREADS } from "@/lib/tarot/spreads";
import { formatLocalDate } from "@/lib/time";
import type { Locale, Reading } from "@/lib/tarot/types";
import type { Messages } from "@/lib/i18n/en";
import { TarotCard } from "@/components/TarotCard";
import { SourceBadge } from "@/components/bits";

export default function ReadingPage() {
  return (
    <Suspense fallback={null}>
      <ReadingView />
    </Suspense>
  );
}

function readingText(r: Reading, a: Analysis, m: Messages, locale: Locale): string {
  const lines = [`${m.reading.shareText} · ${m.spreads[r.spread].name} · ${formatLocalDate(r.localDate, locale)}`];
  if (r.question) lines.push(`${m.reading.yourQuestion}: ${r.question}`);
  lines.push("");
  a.perCard.forEach((c) => {
    lines.push(`【${c.position[locale]}】${c.name[locale]}${c.reversed ? ` (${m.common.reversed})` : ""}`);
    lines.push(c.keywords[locale].join(" · "));
    lines.push(c.meaning[locale]);
    lines.push("");
  });
  lines.push(`${m.reading.synthesis}: ${a.summary[locale]}`);
  lines.push(`${m.reading.action}: ${a.action[locale]}`);
  lines.push("", m.disclaimer);
  return lines.join("\n");
}

function ReadingView() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const { m, fmt, pick, locale } = useI18n();
  const [reading, setReading] = useState<Reading | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    const r = getReading(id);
    // Guard against stale history from older deck versions.
    setReading(r && r.cards.every((c) => hasCard(c.id)) && r.cards.length === SPREADS[r.spread].count ? r : null);
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, [id]);

  const analysis = useMemo(() => (reading ? analyze(reading.spread, reading.cards, reading.topic) : null), [reading]);

  if (reading === undefined) return null;
  if (!reading || !analysis) {
    return (
      <div className="stack gap-16" style={{ maxWidth: 560 }}>
        <h1 className="h1">{m.reading.notFoundTitle}</h1>
        <p className="lede">{m.reading.notFoundBody}</p>
        <div><Link href="/tarot/new" className="btn btn-primary">{m.reading.newQuestion}</Link></div>
      </div>
    );
  }

  const def = SPREADS[reading.spread];
  const text = readingText(reading, analysis, m, locale);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  async function share() {
    try {
      await navigator.share({ title: m.reading.shareText, text });
    } catch {
      /* user cancelled */
    }
  }

  return (
    <div className="stack gap-32">
      <header className="stack gap-12">
        <span className="meta">{formatLocalDate(reading.localDate, locale)} · {m.spreads[reading.spread].name} · {m.topics[reading.topic]}</span>
        {reading.question ? (
          <>
            <span className="visually-hidden">{m.reading.yourQuestion}</span>
            <h1 className="quote" style={{ fontSize: "clamp(22px, 3.4vw, 30px)" }}>{reading.question}</h1>
          </>
        ) : (
          <h1 className="h1">{m.reading.noQuestion}</h1>
        )}
        {params.get("local") === "0" && <p className="notice">{m.common.storageOff}</p>}
      </header>

      <div className="reading">
        <aside className="reading-cards">
          <div className="slots">
            {reading.cards.map((c, i) => (
              <div className="slot" key={i}>
                <TarotCard id={c.id} reversed={c.reversed} revealed label={`${pick(def.positions[i])}: ${pick(getCard(c.id).name)}`} />
                <span className="meta">{pick(def.positions[i])}</span>
              </div>
            ))}
          </div>
        </aside>

        <div className="stack gap-24">
          <section className="panel stack gap-12">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <h2 className="h2">{m.reading.synthesis}</h2>
              <SourceBadge source="offline" />
            </div>
            <p style={{ margin: 0 }}>{pick(analysis.summary)}</p>
            {analysis.choice && (
              <p className="meta" style={{ margin: 0 }}>
                {m.reading.choiceScore}: A {analysis.choice.scoreA} · B {analysis.choice.scoreB}
              </p>
            )}
            <div className="stack gap-4" style={{ marginTop: 4 }}>
              <span className="meta">{m.reading.action}</span>
              <p className="quote">{pick(analysis.action)}</p>
            </div>
          </section>

          <section aria-label={m.reading.cards}>
            {analysis.perCard.map((c, i) => (
              <article className="card-block" key={i}>
                <TarotCard id={c.id} reversed={c.reversed} revealed label={pick(c.name)} />
                <div>
                  <span className="meta">{String(i + 1).padStart(2, "0")} · {pick(c.position)}</span>
                  <h3 className="h3" style={{ marginTop: 4 }}>
                    {pick(c.name)}{" "}
                    {c.reversed && <span className="badge tag-rev" style={{ verticalAlign: "middle" }}>{m.common.reversed}</span>}
                  </h3>
                  <div className="kw">{c.keywords[locale].map((k) => <span key={k}>{k}</span>)}</div>
                  <p style={{ margin: "0 0 8px" }}>{pick(c.meaning)}</p>
                  {c.topicLine && (
                    <p className="muted" style={{ margin: "0 0 8px" }}>
                      <strong style={{ color: "var(--text-1)", fontWeight: 500 }}>{fmt(m.reading.topicLine, { topic: m.topics[reading.topic] })}</strong>
                      {pick(c.topicLine)}
                    </p>
                  )}
                  <p className="muted small" style={{ margin: 0 }}>→ {pick(c.advice)}</p>
                </div>
              </article>
            ))}
          </section>

          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={copy} aria-live="polite">{copied ? m.common.copied : m.common.copy}</button>
            {canShare && <button type="button" className="btn btn-ghost" onClick={share}>{m.common.share}</button>}
            <Link href={`/tarot/new?from=${reading.id}`} className="btn btn-ghost">{m.reading.drawAgain}</Link>
            <Link href="/tarot/new" className="btn btn-text">{m.reading.newQuestion}</Link>
          </div>
          <p className="muted small" style={{ margin: 0 }}>{m.disclaimer}</p>
        </div>
      </div>
    </div>
  );
}
