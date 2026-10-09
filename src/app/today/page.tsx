"use client";
// Today (Guidance): today's card (one per local day and focus, saved so it never changes), the daily
// horoscope from real transits, and the live sky. Sources are labelled separately: card = Library,
// horoscope = Template / Live AI / AI · saved, sky = Live sky. The small orb pulses only while the
// horoscope's AI request is actually running.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { getDaily, getDeviceId, getSettings, saveDaily, saveReading } from "@/lib/store";
import { dailyCard } from "@/lib/tarot/daily";
import { getCard } from "@/lib/tarot/deck";
import { formatLocalDate, localDateKey, userTimeZone } from "@/lib/time";
import type { DrawnCard, Topic } from "@/lib/tarot/types";
import { TarotCard } from "@/components/TarotCard";
import { learnHref } from "@/lib/learn";
import { SourceBadge } from "@/components/bits";
import { ShareImage } from "@/components/ShareImage";
import { dailyCard as dailyShareCard } from "@/lib/share/content";
import { firstSentence } from "@/lib/tarot/engine";
import { SkyPanel } from "@/components/SkyPanel";
import { HoroscopePanel } from "@/components/HoroscopePanel";
import { StateOrb, type OrbMode } from "@/components/cosmos/StateOrb";

const TOPICS: Topic[] = ["general", "love", "work", "growth"];

export default function TodayPage() {
  const { m, fmt, pick, pickList, locale } = useI18n();
  const [date, setDate] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [tz, setTz] = useState("UTC");
  const [topic, setTopic] = useState<Topic>("general");
  const [drawn, setDrawn] = useState<DrawnCard | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [orb, setOrb] = useState<OrbMode>("quiet");

  // The local date is only known in the browser; also refresh it if the tab stays open past midnight.
  useEffect(() => {
    setTz(userTimeZone());
    const update = () => {
      setDate(localDateKey());
      setNow(new Date());
    };
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!date) return;
    const saved = getDaily(date, topic);
    setDrawn(saved);
    setRevealed(!!saved);
  }, [date, topic]);

  const onBusy = useCallback((busy: boolean) => setOrb((o) => (busy ? "pulse" : o === "pulse" ? "settle" : o)), []);

  function reveal() {
    if (!date) return;
    const card = dailyCard(getDeviceId(), date, topic, getSettings().reversals);
    saveDaily(date, topic, card);
    saveReading({
      id: `daily-${date}-${topic}`,
      kind: "daily",
      createdAt: new Date().toISOString(),
      localDate: date,
      spread: "single",
      topic,
      cards: [card],
      seed: `daily|${date}|${topic}`,
    });
    setDrawn(card);
    // Let the face-down card mount first so the flip animates (rAF would stall in a background tab).
    window.setTimeout(() => setRevealed(true), 50);
  }

  if (!date) return null;
  const card = drawn ? getCard(drawn.id) : null;
  const side = card && drawn ? (drawn.reversed ? card.reversed : card.upright) : null;

  return (
    <div className="stack gap-8">
      <header className="row" style={{ gap: 18, alignItems: "center" }}>
        <StateOrb mode={orb} size="72px" />
        <div className="stack gap-1">
          <p className="eyebrow">{m.nav.guidance} · {formatLocalDate(date, locale)}</p>
          <h1 className="h1">{m.daily.title}</h1>
        </div>
      </header>

      <div className="today-grid">
        <section className="panel stack gap-4" aria-labelledby="card-title">
          <div className="row-between">
            <h2 className="h3" id="card-title">{m.daily.cardTitle}</h2>
            {card && <SourceBadge source="library" />}
          </div>
          <p className="muted small" style={{ margin: 0 }}>{fmt(m.daily.subtitle, { date: formatLocalDate(date, locale) })}</p>
          <div className="btn-row" role="group" aria-label={m.daily.topic}>
            {TOPICS.map((t) => (
              <button key={t} type="button" className="chip" aria-pressed={topic === t} onClick={() => setTopic(t)}>{m.topics[t]}</button>
            ))}
          </div>
          <div className="today-card">
            <TarotCard
              id={drawn?.id}
              reversed={drawn?.reversed}
              revealed={revealed}
              label={card ? pick(card.name) : m.daily.reveal}
              onClick={drawn ? undefined : reveal}
              style={{ ["--w" as string]: "clamp(140px, 38vw, 190px)" }}
            />
            {card && side && drawn ? (
              <div className="stack gap-3 reveal-in" aria-live="polite" style={{ minWidth: 0 }}>
                <h3 className="h2" style={{ margin: 0 }}>
                  {pick(card.name)} {drawn.reversed && <span className="badge tag-rev" style={{ verticalAlign: "middle" }}>{m.common.reversed}</span>}
                </h3>
                <div className="kw">{pickList(side.keywords).map((k) => <span key={k}>{k}</span>)}</div>
                <p style={{ margin: 0 }}>{pick(side.meaning)}</p>
                {topic !== "general" && <p className="muted" style={{ margin: 0 }}>{pick(side[topic])}</p>}
                <p className="quote">{pick(side.advice)}</p>
              </div>
            ) : (
              <div className="stack gap-3">
                <p className="muted" style={{ margin: 0 }}>{m.daily.intro}</p>
                <div><button type="button" className="btn btn-primary btn-lg" onClick={reveal}>{m.daily.reveal}</button></div>
              </div>
            )}
          </div>
          {card && side && drawn && (
            <div className="btn-row">
              <Link href={learnHref("card", card.id)} className="btn btn-ghost">{m.daily.learnCard}</Link>
              <ShareImage
                filename={`moona-today-${date}.png`}
                build={() => dailyShareCard(date, card.id, drawn.reversed, pick(card.name), firstSentence(pick(side.meaning)), m, locale)}
              />
              <span className="muted small">{m.daily.comeBack}</span>
            </div>
          )}
        </section>

        <HoroscopePanel localDate={date} timeZone={tz} onBusy={onBusy} />
      </div>

      {now && <SkyPanel localDate={date} timeZone={tz} now={now} />}
    </div>
  );
}
