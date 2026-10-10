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
import type { Locale, Reading, TarotAiResult } from "@/lib/tarot/types";
import { TarotCard } from "@/components/TarotCard";
import { SourceBadge, aiSource } from "@/components/bits";
import { newRequestId, requestAi, requestAiOnce, type AiOutcome } from "@/lib/ai/client";
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
  // Why live AI is not shown (quota, budget, paused, busy), and whether tonight's budget runs low.
  const [notice, setNotice] = useState<string | null>(null);
  const [low, setLow] = useState(false);
  // Out of free readings: this browser's pack credits (null when there is no account), and what
  // happened when the person chose to use one.
  const [credits, setCredits] = useState<number | null | undefined>(undefined);
  // AI itself can't be used here (not configured, or locked): only then is the follow-up chat closed.
  // Running out of free readings is not that: pack follow-ups and the chat's own allowance still work.
  const [aiDown, setAiDown] = useState(false);
  const [packNote, setPackNote] = useState<string | null>(null);
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

  // What the AI is asked about this spread, in one language.
  const bodyFor = useCallback((r: Reading, reqLocale: Locale) => ({
    locale: reqLocale, spread: r.spread, topic: r.topic, question: r.question, cards: r.cards,
    chart: r.includeChart ? chart : undefined,
    notes: sharedNotes(r).map((n) => n.text),
  }), [chart]);

  const showRefusal = useCallback((out: Exclude<AiOutcome<TarotAiResult>, { state: "done" }>) => {
    setOrb("quiet");
    setAiDown(out.state === "offline" && (out.reason === "unconfigured" || out.reason === "locked"));
    if (out.state === "quota") {
      setNotice(m.aiNotice.quota);
      setCredits(out.credits);
      return setAiStatus("off");
    }
    if (out.state === "no_credits" || out.state === "needs_login") {
      setPackNote(out.state === "no_credits" ? m.packs.noCredits : m.packs.needsAccount);
      setCredits(out.state === "no_credits" ? 0 : null);
      setNotice(m.aiNotice.quota);
      return setAiStatus("off");
    }
    if (out.state === "offline") {
      const r2 = out.reason;
      setNotice(r2 === "budget" ? m.aiNotice.budget : r2 === "busy" ? m.aiNotice.busy : r2 === "ledger" || r2 === "paused" || r2 === "paid_capacity" ? m.aiNotice.paused : null);
      return setAiStatus(r2 === "network" ? "failed" : "off");
    }
    setAiStatus("failed");
  }, [m]);

  // Generate the AI interpretation in the background as soon as the page opens (once per reading +
  // language). The request id is saved with the reading before sending, so a reload or a second tab
  // replays the same request for free; "Try again" uses a new one. The result is merged into the
  // latest copy, for its own language only.
  const generate = useCallback(async (r: Reading, fresh: boolean) => {
    const reqLocale = locale;
    const epoch = dataEpoch();
    const remember = (requestId: string) => patchReading(r.id, (latest) => ({ ...latest, aiRequest: { ...latest.aiRequest, [reqLocale]: requestId } }));
    const requestId = (!fresh && r.aiRequest?.[reqLocale]) || newRequestId();
    remember(requestId);
    setAiStatus("loading");
    setNotice(null);
    setPackNote(null);
    setOrb("pulse");
    let out: AiOutcome<TarotAiResult>;
    try {
      out = await requestAiOnce<TarotAiResult>("/api/ai/tarot", bodyFor(r, reqLocale), { requestId, onNewId: remember });
    } catch {
      out = { state: "offline", reason: "network" };
    }
    if (epoch !== dataEpoch()) return;
    if (out.state !== "done") return showRefusal(out);
    setAiDown(false);
    const body = out.value;
    const next = patchReading(r.id, (latest) => (latest.ai?.[reqLocale] ? latest : { ...latest, ai: { ...latest.ai, [reqLocale]: { cards: body.cards, synthesis: body.synthesis, action: body.action, reflection: body.reflection, meta: body.meta } } }));
    if (!next) return; // deleted while it was being written
    setCredits(undefined);
    setLow(out.budgetLevel === "warn" || out.budgetLevel === "critical");
    setAiStatus("live");
    setOrb("settle");
  }, [locale, bodyFor, showRefusal]);

  // A pack reading is never automatic: only the person's tap on "Use a pack reading" (after the free
  // readings ran out) can start one, and a spread gets at most one, in the language it was asked in;
  // its follow-ups work in either language. Only the request id is saved before sending (no text, so
  // a withdrawn or deleted note is never sent again). Everything else (a reload, "Try again", a lost
  // answer, even on the last credit) asks the server for that request's answer with replayOnly, which
  // can return what was paid for but can never start or charge a new one. If the server never got the
  // request, or the attempt failed and its credit came back, the choice is simply offered again.
  const generatePaid = useCallback(async (r: Reading, how: "tap" | "resume") => {
    if (r.paid?.paidReadingId) return;
    const pending = r.paid ?? null;
    if (how === "resume" && !pending) return;
    const reqLocale = pending?.locale ?? locale;
    const requestId = pending?.requestId ?? newRequestId();
    const epoch = dataEpoch();
    patchReading(r.id, (latest) => ({ ...latest, paid: { locale: reqLocale, requestId } })); // drops any older saved body
    setAiStatus("loading");
    setNotice(null);
    setPackNote(null);
    setOrb("pulse");
    const body = { ...bodyFor(r, reqLocale), use: "paid" };
    const send = (replayOnly: boolean) => requestAi<TarotAiResult>("/api/ai/tarot", replayOnly ? { ...body, replayOnly: true } : body, { requestId });
    let out: AiOutcome<TarotAiResult>;
    try {
      out = await send(how === "resume");
      // the same id with other context (a note withdrawn since): fetch the earlier answer instead
      if (out.state === "failed" && out.code === "key_reused") out = await send(true);
    } catch {
      out = { state: "offline", reason: "network" };
    }
    if (epoch !== dataEpoch()) return;
    const forget = () => patchReading(r.id, (latest) => ({ ...latest, paid: undefined }));
    if (out.state === "retry" || (out.state === "failed" && (out.code === "no_such_request" || out.code === "key_reused"))) {
      // never made, or failed with its credit back: forget it and show the current offer (no new charge)
      const next = forget();
      if (next) void generate(next, true);
      return;
    }
    if (out.state === "offline" && out.reason === "network") return showRefusal(out); // may have reached the server: kept, replayed later
    if (out.state !== "done") {
      forget(); // refused before anything was recorded (paused, busy, crisis, no credits...): offer again later
      return showRefusal(out);
    }
    const value = out.value;
    const left = out.paid?.followupsLeft ?? 0;
    const next = patchReading(r.id, (latest) => ({
      ...latest,
      ai: latest.ai?.[reqLocale] ? latest.ai : { ...latest.ai, [reqLocale]: { cards: value.cards, synthesis: value.synthesis, action: value.action, reflection: value.reflection, meta: value.meta } },
      paid: { locale: reqLocale, requestId, ...(out.paid ? { paidReadingId: out.paid.paidReadingId } : {}), followupsLeft: left, followupsTotal: left },
    }));
    if (!next) return;
    setCredits(undefined);
    setLow(out.budgetLevel === "warn" || out.budgetLevel === "critical");
    setAiDown(false);
    setOrb("settle");
    if (reqLocale === locale) setAiStatus("live");
    else void generate(next, false); // this page is in the other language: its own (free) reading, if any is left
  }, [locale, bodyFor, showRefusal, generate]);

  useEffect(() => {
    if (!reading) return;
    if (reading.ai?.[locale]) {
      setAiStatus((s) => (s === "live" ? s : "saved"));
      return;
    }
    const key = `${reading.id}|${locale}|${attempt}`;
    if (requested.current.has(key)) return;
    requested.current.add(key);
    // a pack reading asked for but not yet seen is fetched again (replay only: no new credit)
    if (reading.paid && !reading.paid.paidReadingId) void generatePaid(reading, "resume");
    else void generate(reading, attempt > 0);
  }, [reading, locale, attempt, generate, generatePaid]);

  // Out of credits: link to packs only where packs can actually be bought.
  const [packsOpen, setPacksOpen] = useState(false);
  useEffect(() => {
    if (credits !== 0) return;
    let live = true;
    fetch("/api/packs", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ payments?: { state?: string }; sales?: { open?: boolean } }>)
      .then((p) => { if (live) setPacksOpen(p.payments?.state !== "unconfigured" && !!p.sales?.open); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [credits]);

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
  // this spread's AI text in this language came from a pack reading
  const paidHere = !!(ai && reading?.paid?.paidReadingId && reading.paid.locale === locale);
  // records from before the total was saved: the product's 2, or more if more are left
  const packFollowups = reading?.paid?.followupsTotal ?? Math.max(2, reading?.paid?.followupsLeft ?? 0);
  const statusLine =
    aiStatus === "loading" ? <span className="status-line"><span className="status-dot" />{m.reading.aiPreparing}</span> :
    ai ? <span className="muted small">{m.reading.aiReady}{paidHere ? ` ${fmt(m.packs.packReading, { n: packFollowups })}` : ""}{low ? ` ${m.aiNotice.low}` : ""}</span> :
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
            {ai ? <SourceBadge source={aiSource(ai.meta, aiStatus === "live")} time={ai.meta.generatedAt} title={ai.meta.model} /> : aiStatus !== "loading" && <SourceBadge source="offline" />}
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

          {paidHere && <p className="muted small" style={{ margin: 0 }}>{fmt(m.packs.packReading, { n: packFollowups })}</p>}
          {!ai && aiStatus === "failed" && (
            <p className="notice">
              {m.reading.aiFallback}{" "}
              <button type="button" className="btn-link" onClick={() => setAttempt((n) => n + 1)}>{m.reading.retryAi}</button>
            </p>
          )}
          {!ai && aiStatus === "off" && <p className="notice-quiet">{notice ?? m.reading.aiOff}</p>}
          {!ai && reading.paid?.paidReadingId && reading.paid.locale !== locale && (
            <p className="muted small" style={{ margin: 0 }}>{fmt(m.packs.paidOtherLanguage, { lang: m.packs.langNames[reading.paid.locale] })}</p>
          )}
          {!ai && aiStatus === "off" && !reading.paid && credits !== undefined && credits !== null && (
            credits > 0 ? (
              <div className="stack gap-2">
                <p style={{ margin: 0 }}>{fmt(m.packs.useOne, { n: credits })}</p>
                <div className="btn-row"><button type="button" className="btn btn-ghost" onClick={() => void generatePaid(reading, "tap")}>{m.packs.useOneCta}</button></div>
              </div>
            ) : (
              (packNote || packsOpen) && <p className="muted small" style={{ margin: 0 }}>{packNote ? `${packNote} ` : ""}{packsOpen && <Link href="/me#packs">{m.packs.packLink}</Link>}</p>
            )
          )}
          {!ai && aiStatus === "off" && credits === null && packNote && <p className="muted small" style={{ margin: 0 }}>{packNote}</p>}
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
            <TarotChat reading={reading} shown={shownSummary} chart={chart} autoFocus={params.get("talk") === "1"} aiUnavailable={aiDown} onBusy={onChatBusy} />
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
