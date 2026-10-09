"use client";
// Ask → Spread → Shuffle & pick → Turn over. Plan v0.2 §3.2; design supplement §5–6.
// The ritual is rhythm, light and space, never a forced wait: shuffling takes ~1.2 s (instant with
// reduced motion), every step can be done by touch or keyboard, and each turned card shows its
// one-line message straight away. The nebula gathers while shuffling and brightens as cards turn.
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { DECK, CARD_BACK, getCard } from "@/lib/tarot/deck";
import { randomSeed, rngFromSeed, shuffle } from "@/lib/tarot/rng";
import { isSpreadId, SPREAD_ORDER, SPREADS, suggestSpread } from "@/lib/tarot/spreads";
import { activeNotes, getBirth, getReading, getSettings, listReadings, saveReading } from "@/lib/store";
import { MAX_NOTES_SENT, type MemoryNote } from "@/lib/memory";
import { detectCrisis } from "@/lib/safety";
import { normalizeQuestion } from "@/lib/tarot/question";
import { firstSentence } from "@/lib/tarot/engine";
import { localDateKey } from "@/lib/time";
import { useMotionLevel } from "@/lib/motion";
import type { DrawnCard, Reading, SpreadId, Topic } from "@/lib/tarot/types";
import { TarotCard } from "@/components/TarotCard";
import { SupportPanel } from "@/components/bits";
import { Nebula, type NebulaMode } from "@/components/nebula/Nebula";

const MAX_QUESTION = 300;
const FAN_SIZE = 22;
const TOPICS: Topic[] = ["general", "love", "work", "growth"];
type Step = "ask" | "spread" | "draw";
type Phase = "shuffle" | "pick" | "reveal";

interface Deal {
  seed: string;
  cards: DrawnCard[]; // the shuffled deck with orientations fixed at shuffle time
}

function deal(allowReversed: boolean): Deal {
  const seed = randomSeed();
  const rng = rngFromSeed(seed);
  const cards = shuffle(DECK, rng).map((c) => ({ id: c.id, reversed: allowReversed && rng() < 0.5 }));
  return { seed, cards };
}

export function NewReading() {
  const { m, fmt, pick } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const motion = useMotionLevel();
  const still = motion !== "full";

  const [step, setStep] = useState<Step>("ask");
  const [question, setQuestion] = useState("");
  const [topic, setTopic] = useState<Topic>("general");
  const [spread, setSpread] = useState<SpreadId | null>(null);
  const [crisis, setCrisis] = useState(false);
  const [hasBirth, setHasBirth] = useState(false);
  const [includeChart, setIncludeChart] = useState(false);
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [includeNotes, setIncludeNotes] = useState(false); // off by default: the person chooses per reading
  const [sameToday, setSameToday] = useState<Reading | null>(null);

  const [phase, setPhase] = useState<Phase>("shuffle");
  const [shuffling, setShuffling] = useState(false);
  const [dealt, setDealt] = useState<Deal | null>(null);
  const [picks, setPicks] = useState<number[]>([]);
  const [revealed, setRevealed] = useState<boolean[]>([]);
  const [announce, setAnnounce] = useState("");
  const [orb, setOrb] = useState<NebulaMode>("idle");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));

  // Prefill from ?spread= and ?from=<readingId> ("same question, new draw"). The question itself never goes in the URL.
  useEffect(() => {
    const s = params.get("spread");
    if (isSpreadId(s)) setSpread(s);
    const from = params.get("from");
    if (from) {
      const prev = getReading(from);
      if (prev) {
        setQuestion(prev.question ?? "");
        setTopic(prev.topic);
        setSpread(prev.spread);
        setIncludeChart(!!prev.includeChart);
        setIncludeNotes(!!prev.noteIds?.length);
        setStep("draw");
      }
    }
  }, [params]);

  useEffect(() => {
    setHasBirth(!!getBirth());
    setNotes(activeNotes().slice(0, MAX_NOTES_SENT));
  }, []);

  useEffect(() => headingRef.current?.focus({ preventScroll: false }), [step, phase]);

  const suggested = useMemo(() => suggestSpread(question), [question]);
  const def = spread ? SPREADS[spread] : null;

  function continueFromAsk(skip = false, allowRepeat = false) {
    const q = skip ? "" : question.trim();
    if (q && detectCrisis(q)) {
      setCrisis(true);
      return;
    }
    // Asked the same thing today? Offer to continue instead of silently drawing again (never a hard lock).
    if (q && !allowRepeat) {
      const today = localDateKey();
      const match = listReadings().find((r) => r.kind === "reading" && r.localDate === today && r.question && normalizeQuestion(r.question) === normalizeQuestion(q));
      if (match) {
        setSameToday(match);
        return;
      }
    }
    setSameToday(null);
    if (skip) setQuestion("");
    setSpread((s) => s ?? suggestSpread(q));
    setStep("spread");
  }

  function startShuffle() {
    setShuffling(true);
    setOrb("gather");
    const d = deal(getSettings().reversals);
    later(() => {
      setDealt(d);
      setPicks([]);
      setRevealed([]);
      setShuffling(false);
      setPhase("pick");
      setOrb("idle");
    }, still ? 0 : 1200);
  }

  function choose(fanIndex: number) {
    if (!def || picks.includes(fanIndex) || picks.length >= def.count) return;
    const next = [...picks, fanIndex];
    setPicks(next);
    setAnnounce(fmt(m.draw.picked, { k: next.length, n: def.count }));
    if (next.length === def.count) {
      setRevealed(Array(def.count).fill(false));
      later(() => setPhase("reveal"), still ? 0 : 450);
    }
  }

  const chosen: DrawnCard[] = dealt ? picks.map((i) => dealt.cards[i]) : [];

  function flip(slot: number) {
    if (revealed[slot]) return;
    setRevealed((r) => {
      const next = r.map((v, i) => (i === slot ? true : v));
      if (next.every(Boolean)) setOrb("settle");
      return next;
    });
    const c = chosen[slot];
    const card = getCard(c.id);
    setAnnounce(`${pick(def!.positions[slot])}: ${pick(card.name)}${c.reversed ? ` (${m.common.reversed})` : ""}`);
  }

  function revealAll() {
    const delay = still ? 0 : 160;
    revealed.forEach((open, i) => {
      if (!open) later(() => flip(i), i * delay);
    });
  }

  function reshuffle() {
    setPhase("shuffle");
    setDealt(null);
    setPicks([]);
    setRevealed([]);
    setOrb("idle");
  }

  function finish() {
    if (!dealt || !spread) return;
    const reading: Reading = {
      id: randomSeed(),
      kind: "reading",
      createdAt: new Date().toISOString(),
      localDate: localDateKey(),
      spread,
      topic,
      question: question.trim() || undefined,
      cards: chosen,
      seed: dealt.seed,
      includeChart: hasBirth && includeChart,
      noteIds: includeNotes && notes.length ? notes.map((n) => n.id) : undefined,
    };
    const persisted = saveReading(reading);
    router.push(`/tarot/r/${reading.id}${persisted ? "" : "?local=0"}`);
  }

  const stepIndex = step === "ask" ? 0 : step === "spread" ? 1 : 2;
  const allRevealed = revealed.length > 0 && revealed.every(Boolean);

  return (
    <div className="stack gap-32">
      <nav className="steps" aria-label={m.draw.progress}>
        {(["ask", "spread", "draw"] as const).map((s, i) => (
          <span key={s} style={{ display: "contents" }}>
            {i > 0 && <span className="step-line" aria-hidden="true" />}
            <span className="step" aria-current={i === stepIndex ? "step" : undefined} data-done={i < stepIndex ? "true" : undefined}>
              <span className="step-dot">{i + 1}</span>
              {m.ask.steps[s]}
            </span>
          </span>
        ))}
      </nav>
      <p className="visually-hidden" aria-live="polite">{announce}</p>

      {step === "ask" && (crisis ? (
        <SupportPanel onEdit={() => setCrisis(false)} />
      ) : (
        <section className="stack gap-24" style={{ maxWidth: 680 }}>
          <div className="stack gap-8">
            <h1 className="h1" tabIndex={-1} ref={headingRef}>{m.ask.title}</h1>
            <p className="lede">{m.ask.subtitle}</p>
          </div>
          <div className="stack gap-8">
            <label htmlFor="q" className="visually-hidden">{m.ask.title}</label>
            <textarea
              id="q"
              className="textarea"
              value={question}
              maxLength={MAX_QUESTION}
              placeholder={m.ask.placeholder}
              onChange={(e) => {
                setQuestion(e.target.value);
                setSameToday(null);
              }}
            />
            <span className="meta" style={{ alignSelf: "flex-end" }}>{fmt(m.ask.count, { n: question.length, max: MAX_QUESTION })}</span>
          </div>
          <div className="stack gap-8">
            <span className="meta">{m.ask.examples}</span>
            <div className="btn-row">
              {m.ask.exampleList.map((ex) => (
                <button key={ex} type="button" className="chip" onClick={() => setQuestion(ex)}>{ex}</button>
              ))}
            </div>
          </div>
          <div className="stack gap-8">
            <span className="meta">{m.ask.topic}</span>
            <div className="btn-row" role="group" aria-label={m.ask.topic}>
              {TOPICS.map((t) => (
                <button key={t} type="button" className="chip" aria-pressed={topic === t} onClick={() => setTopic(t)}>{m.topics[t]}</button>
              ))}
            </div>
          </div>
          {(hasBirth || notes.length > 0) && (
            <div className="panel-quiet stack gap-4">
              <span className="meta">{m.ask.contextTitle}</span>
              {hasBirth && (
                <label className="check">
                  <input type="checkbox" checked={includeChart} onChange={(e) => setIncludeChart(e.target.checked)} />
                  <span className="stack">
                    <span>{m.ask.includeChart}</span>
                    <span className="muted small">{m.ask.includeChartHint}</span>
                  </span>
                </label>
              )}
              {notes.length > 0 && (
                <div className="stack gap-8">
                  <label className="check">
                    <input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} />
                    <span className="stack">
                      <span>{fmt(m.notes.shareLabel, { n: notes.length })}</span>
                      <span className="muted small">{m.notes.shareHint}</span>
                    </span>
                  </label>
                  {includeNotes && (
                    <ul className="small" style={{ margin: 0, paddingLeft: 44, color: "var(--text-2)" }}>
                      {notes.map((n) => <li key={n.id}>{n.text}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
          {sameToday ? (
            <div className="panel stack gap-12" role="status">
              <h2 className="h3">{m.ask.sameTitle}</h2>
              <p className="muted" style={{ margin: 0 }}>{m.ask.sameBody}</p>
              <div className="btn-row">
                <button type="button" className="btn btn-primary" onClick={() => router.push(`/tarot/r/${sameToday.id}`)}>{m.ask.sameContinue}</button>
                <button type="button" className="btn btn-ghost" onClick={() => router.push(`/tarot/r/${sameToday.id}?talk=1`)}>{m.ask.sameAdd}</button>
                <button type="button" className="btn-text" onClick={() => continueFromAsk(false, true)}>{m.ask.sameRedraw}</button>
              </div>
            </div>
          ) : (
            <div className="btn-row">
              <button type="button" className="btn btn-primary btn-lg" onClick={() => continueFromAsk()} disabled={!question.trim()}>{m.ask.continue}</button>
              <button type="button" className="btn-text" onClick={() => continueFromAsk(true)}>{m.ask.skip}</button>
            </div>
          )}
        </section>
      ))}

      {step === "spread" && (
        <section className="stack gap-24">
          <div className="stack gap-8">
            <h1 className="h1" tabIndex={-1} ref={headingRef}>{m.spreadStep.title}</h1>
            <p className="lede">{m.spreadStep.subtitle}</p>
          </div>
          <div className="spread-grid">
            {SPREAD_ORDER.map((id) => (
              <button key={id} type="button" className="spread-option" aria-pressed={spread === id} onClick={() => setSpread(id)}>
                <span className="row-between">
                  <span className="spread-diagram" aria-hidden="true">{SPREADS[id].positions.map((_, i) => <i key={i} />)}</span>
                  {question.trim() && id === suggested && <span className="badge badge-mist">{m.spreads.suggested}</span>}
                </span>
                <span className="h3">{m.spreads[id].name}</span>
                <span className="muted small">{m.spreads[id].desc}</span>
                <span className="meta">{SPREADS[id].positions.map((p) => pick(p)).join(" · ")}</span>
              </button>
            ))}
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-lg" disabled={!spread} onClick={() => { setPhase("shuffle"); setStep("draw"); }}>{m.ask.continue}</button>
            <button type="button" className="btn-text" onClick={() => setStep("ask")}>{m.common.back}</button>
          </div>
        </section>
      )}

      {step === "draw" && def && (
        <section className="ritual" data-phase={phase}>
          {question.trim() && <p className="quote" style={{ justifySelf: "stretch", textAlign: "left" }}>{question.trim()}</p>}

          <div className="stack gap-8">
            <h1 className="h1" tabIndex={-1} ref={headingRef}>
              {phase === "shuffle" ? m.draw.shuffleTitle : phase === "pick" ? (def.count === 1 ? m.draw.pickTitleOne : fmt(m.draw.pickTitle, { n: def.count })) : m.draw.revealTitle}
            </h1>
            <p className="lede">{phase === "shuffle" ? m.draw.shuffleHint : phase === "pick" ? m.draw.pickHint : m.draw.revealHint}</p>
            {phase === "pick" && <span className="meta">{fmt(m.draw.picked, { k: picks.length, n: def.count })}</span>}
          </div>

          {/* One nebula for the whole ritual: it gathers while shuffling, then settles behind the cards. */}
          <div className="ritual-stage">
            <Nebula mode={orb} size="min(64vw, 300px)" particles className="ritual-orb" />

            {phase === "shuffle" && (
              <div className="shuffle-stack" data-active={shuffling} aria-hidden="true">
                {[0, 1, 2, 3, 4].map((i) => <img key={i} src={CARD_BACK} alt="" style={{ transform: `translateY(${-i * 2}px)` }} />)}
              </div>
            )}

            {phase === "pick" && dealt && (
              <div className="stack gap-8" style={{ width: "100%" }}>
                <div className="fan" role="group" aria-label={m.draw.deckLabel}>
                  {Array.from({ length: FAN_SIZE }, (_, i) => {
                    const angle = -32 + (64 / (FAN_SIZE - 1)) * i;
                    const isPicked = picks.includes(i);
                    return (
                      <TarotCard
                        key={i}
                        label={fmt(m.draw.faceDown, { i: i + 1, n: FAN_SIZE })}
                        onClick={() => choose(i)}
                        disabled={isPicked || picks.length >= def.count}
                        picked={isPicked}
                        style={{ ["--r" as string]: `${angle.toFixed(1)}deg` }}
                      />
                    );
                  })}
                </div>
                <span className="fan-hint">{m.draw.swipeHint}</span>
              </div>
            )}
          </div>

          {phase === "shuffle" && (
            <button type="button" className="btn btn-primary btn-lg" onClick={startShuffle} disabled={shuffling}>
              {shuffling ? m.draw.shuffling : m.draw.shuffle}
            </button>
          )}

          {phase !== "shuffle" && dealt && (
            <>
              <div className="slots" data-count={def.count}>
                {def.positions.map((pos, i) => {
                  const c = chosen[i];
                  const open = phase === "reveal" && revealed[i];
                  const card = c ? getCard(c.id) : null;
                  return (
                    <div className="slot" key={i} data-fresh={c ? "true" : undefined}>
                      <span className="meta">{pick(pos)}</span>
                      {c ? (
                        <TarotCard
                          id={c.id}
                          reversed={c.reversed}
                          revealed={open}
                          label={open && card ? `${pick(pos)}: ${pick(card.name)}` : `${pick(pos)}: ${m.draw.tapToTurn}`}
                          onClick={phase === "reveal" && !open ? () => flip(i) : undefined}
                        />
                      ) : (
                        <span className="slot-empty">{m.draw.slotEmpty}</span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Each card's one-line message, as soon as it is turned over. */}
              {revealed.some(Boolean) && (
                <ol className="reveal-lines" aria-live="polite">
                  {def.positions.map((pos, i) => {
                    const c = chosen[i];
                    if (!c || !revealed[i]) return null;
                    const card = getCard(c.id);
                    return (
                      <li key={i} className="reveal-in">
                        <span className="meta">{pick(pos)} · {pick(card.name)}{c.reversed ? ` · ${m.common.reversed}` : ""}</span>
                        <span className="phrase-line">{firstSentence(pick(c.reversed ? card.reversed.meaning : card.upright.meaning))}</span>
                      </li>
                    );
                  })}
                </ol>
              )}

              <div className="btn-row" style={{ justifyContent: "center" }}>
                {phase === "reveal" && !allRevealed && <button type="button" className="btn btn-ghost" onClick={revealAll}>{m.draw.revealAll}</button>}
                {phase === "reveal" && allRevealed && <button type="button" className="btn btn-primary btn-lg" onClick={finish}>{m.draw.seeReading}</button>}
                <button type="button" className="btn-text" onClick={reshuffle}>{m.draw.reshuffle}</button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
