"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { getDaily, getDeviceId, getSettings, saveDaily, saveReading } from "@/lib/store";
import { dailyCard } from "@/lib/tarot/daily";
import { getCard } from "@/lib/tarot/deck";
import { formatLocalDate, localDateKey, userTimeZone } from "@/lib/time";
import type { DrawnCard, Topic } from "@/lib/tarot/types";
import { TarotCard } from "@/components/TarotCard";
import { SourceBadge } from "@/components/bits";
import { SkyPanel } from "@/components/SkyPanel";

const TOPICS: Topic[] = ["general", "love", "work", "growth"];

export default function TodayPage() {
  const { m, fmt, pick, pickList, locale } = useI18n();
  const [date, setDate] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [tz, setTz] = useState("UTC");
  const [topic, setTopic] = useState<Topic>("general");
  const [drawn, setDrawn] = useState<DrawnCard | null>(null);
  const [revealed, setRevealed] = useState(false);

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
    <div className="stack gap-32">
      <header className="stack gap-12">
        <h1 className="h1">{m.daily.title}</h1>
        <p className="lede">{fmt(m.daily.subtitle, { date: formatLocalDate(date, locale) })}</p>
        <div className="btn-row" role="group" aria-label={m.daily.topic}>
          {TOPICS.map((t) => (
            <button key={t} type="button" className="chip" aria-pressed={topic === t} onClick={() => setTopic(t)}>{m.topics[t]}</button>
          ))}
        </div>
      </header>

      <section className="reading">
        <div className="reading-cards" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <TarotCard
            id={drawn?.id}
            reversed={drawn?.reversed}
            revealed={revealed}
            label={card ? pick(card.name) : m.daily.reveal}
            onClick={drawn ? undefined : reveal}
            style={{ ["--w" as string]: "clamp(150px, 42vw, 220px)" }}
          />
          {!drawn && <button type="button" className="btn btn-primary" onClick={reveal}>{m.daily.reveal}</button>}
        </div>

        {card && side && drawn ? (
          <div className="panel stack gap-12" aria-live="polite">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <h2 className="h2">
                {pick(card.name)}{" "}
                {drawn.reversed && <span className="badge tag-rev" style={{ verticalAlign: "middle" }}>{m.common.reversed}</span>}
              </h2>
              <SourceBadge source="library" />
            </div>
            <div className="kw">{pickList(side.keywords).map((k) => <span key={k}>{k}</span>)}</div>
            <p style={{ margin: 0 }}>{pick(side.meaning)}</p>
            {topic !== "general" && <p className="muted" style={{ margin: 0 }}>{pick(side[topic])}</p>}
            <p className="quote">{pick(side.advice)}</p>
            <p className="meta" style={{ margin: 0 }}>{m.daily.comeBack}</p>
          </div>
        ) : (
          <div />
        )}
      </section>

      <section className="grid-tiles">
        {now && <SkyPanel localDate={date} timeZone={tz} now={now} />}
        <div className="panel stack gap-8">
          <SourceBadge source="dev" />
          <h2 className="h3">{m.daily.horoscopeTitle}</h2>
          <p className="muted small" style={{ margin: 0 }}>{m.daily.horoscopeDev}</p>
        </div>
      </section>
    </div>
  );
}
