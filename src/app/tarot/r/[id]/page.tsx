"use client";
// Reading result with layered reveal (combined review §塔罗; design supplement §5–6):
// 1. the cards and one-line messages; 2. the full interpretation when the person asks for it (AI is
// prepared in the background as soon as the page opens; the offline reading is always there);
// 3. "Why this reading" — exactly which inputs and rules the text came from; 4. a question to sit
// with; 5. continue with these cards; 6. an optional check-in. The small orb pulses only while a
// real AI request is running, brightens once when a new result arrives, and stays quiet for saved text.
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useRouteSegment } from "@/lib/shell";
import { dataEpoch, getBirth, getReading, patchReading, useStoreVersion } from "@/lib/store";
import { analyze, type Analysis } from "@/lib/tarot/engine";
import { getCard, hasCard } from "@/lib/tarot/deck";
import { SPREADS } from "@/lib/tarot/spreads";
import { formatLocalDate } from "@/lib/time";
import { bigThreeLocalized, bigThreeNames, type BigThreeNames } from "@/lib/astro/summary";
import type { MemoryNote } from "@/lib/memory";
import type { Reading, TarotAiResult } from "@/lib/tarot/types";
import { TarotCard } from "@/components/TarotCard";
import { SourceBadge } from "@/components/bits";
import { TarotChat } from "@/components/TarotChat";
import { SharedNotes, sharedNotes } from "@/components/Notes";
import { CheckInPlanner } from "@/components/CheckIns";
import { learnHref } from "@/lib/learn";
import { ShareSheet } from "@/components/ShareImage";
import { readingCard, readingShareText } from "@/lib/share/content";
import { StateOrb, type OrbMode } from "@/components/cosmos/StateOrb";

export default function ReadingPage() {
  return (
    <Suspense fallback={null}>
      <ReadingView />
    </Suspense>
  );
}

type AiStatus = "idle" | "loading" | "live" | "saved" | "failed" | "off";

function ReadingView() {
  const id = useRouteSegment(useParams<{ id: string }>().id, 2); // null until known on the offline shell
  const params = useSearchParams();
  const { m, fmt, pick, locale } = useI18n();
  const version = useStoreVersion();
  const [reading, setReading] = useState<Reading | null | undefined>(undefined);
  const [chart, setChart] = useState<BigThreeNames | undefined>(undefined);
  const [chartShown, setChartShown] = useState<BigThreeNames | undefined>(undefined);
  const [expanded, setExpanded] = useState(params.get("talk") === "1");
  const [showOffline, setShowOffline] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatus>("idle");
  const [attempt, setAttempt] = useState(0);
  const [orb, setOrb] = useState<OrbMode>("quiet");
  const requested = useRef(new Set<string>());

  useEffect(() => {
    if (id === null) return;
    const r = getReading(id);
    setReading(r && r.cards.every((c) => hasCard(c.id)) && r.cards.length === SPREADS[r.spread].count ? r : null);
    const birth = getBirth();
    setChart(birth ? bigThreeNames(birth) : undefined);
    setChartShown(birth ? bigThreeLocalized(birth, locale) : undefined);
  }, [id, version, locale]);

  const analysis = useMemo(() => (reading ? analyze(reading.spread, reading.cards, reading.topic) : null), [reading]);
  const ai = reading?.ai?.[locale];
  const notes = useMemo(() => (reading ? sharedNotes(reading) : []), [reading]);

  // Generate the AI interpretation in the background as soon as the page opens (once per reading +
  // language). The result is merged into the latest copy, for its own language only.
  const generate = useCallback(async (r: Reading) => {
    const reqLocale = locale;
    const epoch = dataEpoch();
    setAiStatus("loading");
    setOrb("pulse");
    try {
      const res = await fetch("/api/ai/tarot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locale: reqLocale, spread: r.spread, topic: r.topic, question: r.question, cards: r.cards,
          chart: r.includeChart ? chart : undefined,
          notes: sharedNotes(r).map((n) => n.text),
        }),
      });
      if (res.status === 503) {
        setOrb("quiet");
        return setAiStatus("off");
      }
      const body = (await res.json().catch(() => ({}))) as TarotAiResult & { code?: string };
      if (!res.ok || body.code) {
        setOrb("quiet");
        return setAiStatus("failed");
      }
      if (epoch !== dataEpoch()) return;
      const next = patchReading(r.id, (latest) => (latest.ai?.[reqLocale] ? latest : { ...latest, ai: { ...latest.ai, [reqLocale]: { cards: body.cards, synthesis: body.synthesis, action: body.action, reflection: body.reflection, meta: body.meta } } }));
      if (!next) return; // deleted while it was being written
      setAiStatus("live");
      setOrb("settle");
    } catch {
      setOrb("quiet");
      setAiStatus("failed");
    }
  }, [locale, chart]);

  useEffect(() => {
    if (!reading) return;
    if (reading.ai?.[locale]) {
      setAiStatus((s) => (s === "live" ? s : "saved"));
      return;
    }
    const key = `${reading.id}|${locale}|${attempt}`;
    if (requested.current.has(key)) return;
    requested.current.add(key);
    void generate(reading);
  }, [reading, locale, attempt, generate]);

  const onChatBusy = useCallback((busy: boolean) => setOrb((o) => (busy ? "pulse" : o === "pulse" ? "settle" : o)), []);

  if (reading === undefined) return null;
  if (!reading || !analysis) {
    return (
      <div className="stack gap-4" style={{ maxWidth: 560 }}>
        <h1 className="h1">{m.reading.notFoundTitle}</h1>
        <p className="lede">{m.reading.notFoundBody}</p>
        <div><Link href="/tarot/new" className="btn btn-primary">{m.reading.newQuestion}</Link></div>
      </div>
    );
  }

  const def = SPREADS[reading.spread];
  const shownSummary = ai ? `${ai.synthesis}\n${ai.action}` : `${pick(analysis.summary)}\n${pick(analysis.action)}`;
  const reflection = ai ? ai.reflection : pick(analysis.reflection);
  const statusLine =
    aiStatus === "loading" ? <span className="status-line"><span className="status-dot" />{m.reading.aiPreparing}</span> :
    ai ? <span className="muted small">{m.reading.aiReady}</span> :
    aiStatus === "off" || aiStatus === "failed" ? <span className="muted small">{m.reading.offlineReady}</span> : null;

  const offlineBlock = (
    <section className="stack gap-3" aria-label={m.reading.offlineTitle}>
      <div className="row-between">
        <h3 className="h3">{m.reading.offlineTitle}</h3>
        {ai && <SourceBadge source="offline" />}
      </div>
      <p style={{ margin: 0 }}>{pick(analysis.summary)}</p>
      {analysis.choice && <p className="meta" style={{ margin: 0 }}>{m.reading.choiceScore}: A {analysis.choice.scoreA} · B {analysis.choice.scoreB}</p>}
      <p className="quote">{pick(analysis.action)}</p>
      {analysis.perCard.map((c, i) => (
        <article className="card-block" key={i}>
          <TarotCard id={c.id} reversed={c.reversed} revealed label={pick(c.name)} />
          <div>
            <span className="meta">{String(i + 1).padStart(2, "0")} · {pick(c.position)}</span>
            <h4 className="h3" style={{ marginTop: 4, fontSize: 19 }}><Link href={learnHref("card", c.id)}>{pick(c.name)}</Link></h4>
            <div className="kw">{c.keywords[locale].map((k) => <span key={k}>{k}</span>)}</div>
            <p style={{ margin: "0 0 8px" }}>{pick(c.meaning)}</p>
            {c.topicLine && (
              <p className="muted" style={{ margin: 0 }}>
                <strong style={{ color: "var(--text-1)", fontWeight: 500 }}>{fmt(m.reading.topicLine, { topic: m.topics[reading.topic] })}</strong>
                {pick(c.topicLine)}
              </p>
            )}
          </div>
        </article>
      ))}
    </section>
  );

  return (
    <div className="stack gap-8">
      <header className="stack gap-3" style={{ maxWidth: 820 }}>
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
        <SharedNotes reading={reading} />
      </header>

      {/* Layer 1: cards + one-line messages */}
      <section className="phrases" aria-label={m.reading.cards}>
        {analysis.perCard.map((c, i) => (
          <article key={i} className="phrase">
            <TarotCard id={c.id} reversed={c.reversed} revealed label={`${pick(def.positions[i])}: ${pick(getCard(c.id).name)}`} />
            <div className="stack gap-1">
              <span className="meta">{pick(c.position)}</span>
              <span className="h3" style={{ fontSize: 21 }}>
                <Link href={learnHref("card", c.id)} style={{ textDecoration: "none" }}>{pick(c.name)}</Link> {c.reversed && <span className="badge tag-rev" style={{ verticalAlign: "middle" }}>{m.common.reversed}</span>}
              </span>
              <p className="phrase-line">{pick(c.phrase)}</p>
            </div>
          </article>
        ))}
      </section>

      {!expanded ? (
        <div className="stack gap-3">
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-lg" onClick={() => setExpanded(true)}>{m.reading.expand}</button>
          </div>
          {statusLine}
        </div>
      ) : (
        <section className="panel interp" aria-live="polite" aria-busy={aiStatus === "loading"}>
          <div className="interp-head">
            <div className="row" style={{ gap: 14 }}>
              <StateOrb mode={orb} size="56px" />
              <h2 className="h2">{m.reading.synthesis}</h2>
            </div>
            {ai ? <SourceBadge source={aiStatus === "live" ? "live" : "saved"} time={ai.meta.generatedAt} title={ai.meta.model} /> : aiStatus !== "loading" && <SourceBadge source="offline" />}
          </div>

          {aiStatus === "loading" && !ai && (
            <div className="stack gap-2">
              <span className="status-line"><span className="status-dot" />{m.reading.aiLoading}</span>
              <div className="skeleton" aria-hidden="true" /><div className="skeleton" aria-hidden="true" /><div className="skeleton short" aria-hidden="true" />
            </div>
          )}

          {ai && (
            <div className="stack gap-4 reveal-in">
              {ai.cards.map((c) => {
                const card = analysis.perCard[c.position];
                return (
                  <div key={c.position} className="interp-section">
                    <span className="meta">{String(c.position + 1).padStart(2, "0")} · {pick(card.position)} · {pick(card.name)}{card.reversed ? ` · ${m.common.reversed}` : ""}</span>
                    <p>{c.insight}</p>
                  </div>
                );
              })}
              <p style={{ margin: 0 }}>{ai.synthesis}</p>
              <div className="interp-section">
                <span className="meta">{m.reading.action}</span>
                <p className="quote">{ai.action}</p>
              </div>
            </div>
          )}

          {!ai && aiStatus === "failed" && (
            <p className="notice">
              {m.reading.aiFallback}{" "}
              <button type="button" className="btn-link" onClick={() => setAttempt((n) => n + 1)}>{m.reading.retryAi}</button>
            </p>
          )}
          {!ai && aiStatus === "off" && <p className="notice-quiet">{m.reading.aiOff}</p>}
          {!ai && aiStatus !== "loading" && offlineBlock}

          {ai && (
            <div>
              <button type="button" className="btn-link" onClick={() => setShowOffline((v) => !v)} aria-expanded={showOffline}>
                {showOffline ? m.reading.hideOffline : m.reading.showOffline}
              </button>
              {showOffline && <div style={{ marginTop: 12 }}>{offlineBlock}</div>}
            </div>
          )}

          <Basis reading={reading} analysis={analysis} ai={ai} chart={reading.includeChart ? chartShown : undefined} notes={notes} />

          <div className="interp-section">
            <span className="meta">{m.reading.reflection}</span>
            <p className="quote">{reflection}</p>
          </div>

          <div className="stack gap-3">
            <h2 className="h3">{m.reading.talk}</h2>
            <p className="muted small" style={{ margin: 0 }}>{m.reading.talkIntro}</p>
            <TarotChat reading={reading} shown={shownSummary} chart={chart} autoFocus={params.get("talk") === "1"} aiUnavailable={aiStatus === "off"} onBusy={onChatBusy} />
          </div>

          <CheckInPlanner readingId={reading.id} suggestedAction={ai ? ai.action : pick(analysis.action)} />

          <button type="button" className="btn-link" style={{ alignSelf: "flex-start" }} onClick={() => setExpanded(false)}>{m.reading.collapse}</button>
        </section>
      )}

      <div className="btn-row">
        <ShareSheet
          filename={`moona-${reading.localDate}.png`}
          options={reading.question ? [{ key: "question", label: m.share.includeQuestion }] : []}
          build={(o) => readingCard(reading, analysis, ai, m, locale, { includeQuestion: !!o.question })}
          text={(o) => readingShareText(reading, analysis, ai, m, locale, { includeQuestion: !!o.question })}
        />
        <Link href={`/tarot/new?from=${reading.id}`} className="btn btn-ghost">{m.reading.drawAgain}</Link>
        <Link href="/tarot/new" className="btn btn-text">{m.reading.newQuestion}</Link>
      </div>
    </div>
  );
}

/** "Why this reading": every input the text was written from, labelled by kind, and how it was written. */
function Basis({ reading, analysis, ai, chart, notes }: { reading: Reading; analysis: Analysis; ai: TarotAiResult | undefined; chart?: BigThreeNames; notes: MemoryNote[] }) {
  const { m, fmt, pick, locale } = useI18n();
  const time = ai ? new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ai.meta.generatedAt)) : "";
  return (
    <details className="panel-quiet basis">
      <summary className="disclosure-summary" style={{ listStyle: "none", cursor: "pointer" }}>{m.reading.basisTitle}</summary>
      <ul className="basis-list" style={{ marginTop: 10 }}>
        <li>
          <span className="badge">{m.reading.basisChoice}</span>
          <span>{m.spreads[reading.spread].name} · {m.topics[reading.topic]}{reading.question ? ` · ${m.reading.basisQuestion}` : ""}</span>
        </li>
        {analysis.perCard.map((c, i) => (
          <li key={i}>
            <span className="badge">{m.badge.library}</span>
            <span>
              <strong style={{ color: "var(--text-1)", fontWeight: 500 }}>{pick(c.position)} · {pick(c.name)} ({c.reversed ? m.common.reversed : m.common.upright})</strong>
              {" — "}{c.keywords[locale].join(", ")}
            </span>
          </li>
        ))}
        {chart && (
          <li>
            <span className="badge">{m.talk.kindCalc}</span>
            <span>{[chart.sun && `${m.chart.sun} ${chart.sun}`, chart.moon && `${m.chart.moon} ${chart.moon}`, chart.rising && `${m.chart.rising} ${chart.rising}`].filter(Boolean).join(" · ")}</span>
          </li>
        )}
        {notes.map((n) => (
          <li key={n.id}>
            <span className="badge">{m.talk.kindSaid}</span>
            <span>{n.text}</span>
          </li>
        ))}
      </ul>
      <p className="muted small" style={{ margin: "12px 0 0" }}>
        {ai ? fmt(m.reading.basisAi, { model: ai.meta.model, time }) : m.reading.basisOffline}
      </p>
      <p className="muted small" style={{ margin: "6px 0 0" }}>{m.reading.basisNote}</p>
    </details>
  );
}
