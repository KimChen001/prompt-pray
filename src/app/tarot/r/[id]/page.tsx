"use client";
// Reading result with layered reveal (combined review §塔罗): one-line card phrases first, the full
// interpretation on demand (AI generated in the background as soon as the page opens, offline
// reading always available), a reflection question, then an optional conversation.
// Functional build; visual design pending.
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useRouteSegment } from "@/lib/shell";
import { getBirth, getReading, saveReading } from "@/lib/store";
import { analyze, type Analysis } from "@/lib/tarot/engine";
import { getCard, hasCard } from "@/lib/tarot/deck";
import { SPREADS } from "@/lib/tarot/spreads";
import { formatLocalDate } from "@/lib/time";
import { bigThreeNames, type BigThreeNames } from "@/lib/astro/summary";
import type { Locale, Reading, TarotAiResult } from "@/lib/tarot/types";
import type { Messages } from "@/lib/i18n/en";
import { TarotCard } from "@/components/TarotCard";
import { SourceBadge } from "@/components/bits";
import { TarotChat } from "@/components/TarotChat";
import { SharedNotes, sharedNotes } from "@/components/Notes";
import { CheckInPlanner } from "@/components/CheckIns";
import { learnHref } from "@/lib/learn";
import { ShareImage } from "@/components/ShareImage";
import { readingCard } from "@/lib/share/content";

export default function ReadingPage() {
  return (
    <Suspense fallback={null}>
      <ReadingView />
    </Suspense>
  );
}

type AiStatus = "idle" | "loading" | "live" | "saved" | "failed" | "off";

function readingText(r: Reading, a: Analysis, ai: TarotAiResult | undefined, m: Messages, locale: Locale): string {
  const lines = [`${m.reading.shareText} · ${m.spreads[r.spread].name} · ${formatLocalDate(r.localDate, locale)}`];
  if (r.question) lines.push(`${m.reading.yourQuestion}: ${r.question}`);
  lines.push("");
  a.perCard.forEach((c, i) => {
    lines.push(`【${c.position[locale]}】${c.name[locale]}${c.reversed ? ` (${m.common.reversed})` : ""}`);
    lines.push(ai ? ai.cards[i].insight : c.meaning[locale]);
    lines.push("");
  });
  lines.push(`${m.reading.synthesis}: ${ai ? ai.synthesis : a.summary[locale]}`);
  lines.push(`${m.reading.action}: ${ai ? ai.action : a.action[locale]}`);
  lines.push(`${m.reading.reflection}: ${ai ? ai.reflection : a.reflection[locale]}`);
  lines.push("", ai ? `(AI · ${ai.meta.model})` : `(${m.badge.offline})`, m.disclaimer);
  return lines.join("\n");
}

function ReadingView() {
  const id = useRouteSegment(useParams<{ id: string }>().id, 2); // null until known on the offline shell
  const params = useSearchParams();
  const { m, fmt, pick, locale } = useI18n();
  const [reading, setReading] = useState<Reading | null | undefined>(undefined);
  const [chart, setChart] = useState<BigThreeNames | undefined>(undefined);
  const [expanded, setExpanded] = useState(params.get("talk") === "1");
  const [showOffline, setShowOffline] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatus>("idle");
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    if (id === null) return;
    const r = getReading(id);
    setReading(r && r.cards.every((c) => hasCard(c.id)) && r.cards.length === SPREADS[r.spread].count ? r : null);
    const birth = getBirth();
    setChart(birth ? bigThreeNames(birth) : undefined);
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, [id]);

  const analysis = useMemo(() => (reading ? analyze(reading.spread, reading.cards, reading.topic) : null), [reading]);
  const ai = reading?.ai?.[locale];

  // Generate the AI interpretation in the background as soon as the page opens (once per reading + language).
  const generate = useCallback(async (r: Reading) => {
    setAiStatus("loading");
    try {
      const res = await fetch("/api/ai/tarot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locale, spread: r.spread, topic: r.topic, question: r.question, cards: r.cards,
          chart: r.includeChart ? chart : undefined,
          notes: sharedNotes(r).map((n) => n.text),
        }),
      });
      if (res.status === 503) return setAiStatus("off");
      if (!res.ok) return setAiStatus("failed");
      const body = (await res.json()) as TarotAiResult & { code?: string };
      if (body.code) return setAiStatus("failed");
      const next: Reading = { ...r, ai: { ...r.ai, [locale]: { cards: body.cards, synthesis: body.synthesis, action: body.action, reflection: body.reflection, meta: body.meta } } };
      saveReading(next);
      setReading(next);
      setAiStatus("live");
    } catch {
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
  const text = readingText(reading, analysis, ai, m, locale);
  const shownSummary = ai ? `${ai.synthesis}\n${ai.action}` : `${pick(analysis.summary)}\n${pick(analysis.action)}`;
  const reflection = ai ? ai.reflection : pick(analysis.reflection);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  const offlineBlock = (
    <section className="stack gap-12" aria-label={m.reading.offlineTitle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h3 className="h3">{m.reading.offlineTitle}</h3>
        <SourceBadge source="offline" />
      </div>
      <p style={{ margin: 0 }}>{pick(analysis.summary)}</p>
      {analysis.choice && (
        <p className="meta" style={{ margin: 0 }}>{m.reading.choiceScore}: A {analysis.choice.scoreA} · B {analysis.choice.scoreB}</p>
      )}
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
        <SharedNotes reading={reading} onChange={setReading} />
      </header>

      {/* Layer 1: cards + one-line phrases */}
      <section className="phrases" aria-label={m.reading.cards}>
        {analysis.perCard.map((c, i) => (
          <article key={i} className="phrase">
            <TarotCard id={c.id} reversed={c.reversed} revealed label={`${pick(def.positions[i])}: ${pick(getCard(c.id).name)}`} />
            <div className="stack gap-4">
              <span className="meta">{pick(c.position)}</span>
              <span className="h3" style={{ fontSize: 20 }}>
                <Link href={learnHref("card", c.id)}>{pick(c.name)}</Link> {c.reversed && <span className="badge tag-rev" style={{ verticalAlign: "middle" }}>{m.common.reversed}</span>}
              </span>
              <p className="phrase-line">{pick(c.phrase)}</p>
            </div>
          </article>
        ))}
      </section>

      {!expanded ? (
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={() => setExpanded(true)}>{m.reading.expand}</button>
          {aiStatus === "loading" && <span className="muted small">{m.reading.aiLoading}</span>}
        </div>
      ) : (
        <section className="panel stack gap-16" aria-live="polite" aria-busy={aiStatus === "loading"}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h2 className="h2">{m.reading.synthesis}</h2>
            {ai ? <SourceBadge source={aiStatus === "live" ? "live" : "saved"} time={ai.meta.generatedAt} title={ai.meta.model} /> : aiStatus !== "loading" && <SourceBadge source="offline" />}
          </div>

          {aiStatus === "loading" && !ai && (
            <div className="stack gap-8" aria-hidden="true">
              <div className="skeleton" /><div className="skeleton" /><div className="skeleton short" />
              <span className="muted small">{m.reading.aiLoading}</span>
            </div>
          )}

          {ai && (
            <>
              {ai.cards.map((c) => {
                const card = analysis.perCard[c.position];
                return (
                  <div key={c.position} className="stack gap-4">
                    <span className="meta">{String(c.position + 1).padStart(2, "0")} · {pick(card.position)} · {pick(card.name)}{card.reversed ? ` · ${m.common.reversed}` : ""}</span>
                    <p style={{ margin: 0 }}>{c.insight}</p>
                  </div>
                );
              })}
              <p style={{ margin: 0 }}>{ai.synthesis}</p>
              <div className="stack gap-4">
                <span className="meta">{m.reading.action}</span>
                <p className="quote">{ai.action}</p>
              </div>
            </>
          )}

          {!ai && aiStatus === "failed" && (
            <p className="notice" style={{ margin: 0 }}>
              {m.reading.aiFallback}{" "}
              <button type="button" className="btn-text" style={{ minHeight: 0, padding: 0 }} onClick={() => setAttempt((n) => n + 1)}>{m.reading.retryAi}</button>
            </p>
          )}
          {!ai && aiStatus !== "loading" && offlineBlock}

          {ai && (
            <div>
              <button type="button" className="btn-text" style={{ padding: 0 }} onClick={() => setShowOffline((v) => !v)} aria-expanded={showOffline}>
                {showOffline ? m.reading.hideOffline : m.reading.showOffline}
              </button>
              {showOffline && <div style={{ marginTop: 12 }}>{offlineBlock}</div>}
            </div>
          )}

          <div className="stack gap-4">
            <span className="meta">{m.reading.reflection}</span>
            <p className="quote">{reflection}</p>
          </div>

          <h2 className="h3">{m.reading.talk}</h2>
          <TarotChat reading={reading} shown={shownSummary} chart={chart} autoFocus={params.get("talk") === "1"} aiUnavailable={aiStatus === "off"} onChange={setReading} />

          <CheckInPlanner readingId={reading.id} suggestedAction={ai ? ai.action : pick(analysis.action)} />

          <button type="button" className="btn-text" style={{ alignSelf: "flex-start", padding: 0 }} onClick={() => setExpanded(false)}>{m.reading.collapse}</button>
        </section>
      )}

      <div className="btn-row">
        <button type="button" className="btn btn-ghost" onClick={copy} aria-live="polite">{copied ? m.common.copied : m.common.copy}</button>
        {canShare && (
          <button type="button" className="btn btn-ghost" onClick={() => navigator.share({ title: m.reading.shareText, text }).catch(() => undefined)}>{m.common.share}</button>
        )}
        <ShareImage
          filename={`moona-${reading.localDate}.png`}
          options={reading.question ? [{ key: "question", label: m.share.includeQuestion }] : []}
          build={(o) => readingCard(reading, analysis, ai, m, locale, { includeQuestion: !!o.question })}
        />
        <Link href={`/tarot/new?from=${reading.id}`} className="btn btn-ghost">{m.reading.drawAgain}</Link>
        <Link href="/tarot/new" className="btn btn-text">{m.reading.newQuestion}</Link>
      </div>
      <p className="muted small" style={{ margin: 0 }}>{m.disclaimer}</p>
    </div>
  );
}
