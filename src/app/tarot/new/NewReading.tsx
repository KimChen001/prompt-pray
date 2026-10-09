"use client";
// Ask → Spread → Shuffle & pick → Reveal. Plan v0.2 §3.2 / v0.1 §4.
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { DECK, CARD_BACK } from "@/lib/tarot/deck";
import { randomSeed, rngFromSeed, shuffle } from "@/lib/tarot/rng";
import { isSpreadId, SPREAD_ORDER, SPREADS, suggestSpread } from "@/lib/tarot/spreads";
import { getReading, getSettings, saveReading } from "@/lib/store";
import { detectCrisis } from "@/lib/safety";
import { localDateKey } from "@/lib/time";
import type { DrawnCard, Reading, SpreadId, Topic } from "@/lib/tarot/types";
import { TarotCard } from "@/components/TarotCard";
import { SupportPanel } from "@/components/bits";

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

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function NewReading() {
  const { m, fmt, pick } = useI18n();
  const router = useRouter();
  const params = useSearchParams();

  const [step, setStep] = useState<Step>("ask");
  const [question, setQuestion] = useState("");
  const [topic, setTopic] = useState<Topic>("general");
  const [spread, setSpread] = useState<SpreadId | null>(null);
  const [crisis, setCrisis] = useState(false);

  const [phase, setPhase] = useState<Phase>("shuffle");
  const [shuffling, setShuffling] = useState(false);
  const [dealt, setDealt] = useState<Deal | null>(null);
  const [picks, setPicks] = useState<number[]>([]);
  const [revealed, setRevealed] = useState<boolean[]>([]);
  const [announce, setAnnounce] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

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
        setStep("draw");
      }
    }
  }, [params]);

  useEffect(() => headingRef.current?.focus(), [step, phase]);

  const suggested = useMemo(() => suggestSpread(question), [question]);
  const def = spread ? SPREADS[spread] : null;

  function continueFromAsk(skip = false) {
    const q = skip ? "" : question.trim();
    if (q && detectCrisis(q)) {
      setCrisis(true);
      return;
    }
    if (skip) setQuestion("");
    setSpread((s) => s ?? suggestSpread(q));
    setStep("spread");
  }

  function startShuffle() {
    setShuffling(true);
    const d = deal(getSettings().reversals);
    window.setTimeout(() => {
      setDealt(d);
      setPicks([]);
      setRevealed([]);
      setShuffling(false);
      setPhase("pick");
    }, prefersReducedMotion() ? 0 : 1200);
  }

  function choose(fanIndex: number) {
    if (!def || picks.includes(fanIndex) || picks.length >= def.count) return;
    const next = [...picks, fanIndex];
    setPicks(next);
    setAnnounce(fmt(m.draw.picked, { k: next.length, n: def.count }));
    if (next.length === def.count) {
      setRevealed(Array(def.count).fill(false));
      window.setTimeout(() => setPhase("reveal"), prefersReducedMotion() ? 0 : 450);
    }
  }

  const chosen: DrawnCard[] = dealt ? picks.map((i) => dealt.cards[i]) : [];

  function flip(slot: number) {
    if (revealed[slot]) return;
    setRevealed((r) => r.map((v, i) => (i === slot ? true : v)));
    const c = chosen[slot];
    const card = DECK.find((d) => d.id === c.id)!;
    setAnnounce(`${pick(def!.positions[slot])}: ${pick(card.name)}${c.reversed ? ` (${m.common.reversed})` : ""}`);
  }

  function revealAll() {
    const delay = prefersReducedMotion() ? 0 : 150;
    revealed.forEach((open, i) => {
      if (!open) window.setTimeout(() => flip(i), i * delay);
    });
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
    };
    const persisted = saveReading(reading);
    router.push(`/tarot/r/${reading.id}${persisted ? "" : "?local=0"}`);
  }

  const stepIndex = step === "ask" ? 0 : step === "spread" ? 1 : 2;
  const allRevealed = revealed.length > 0 && revealed.every(Boolean);

  return (
    <div className="stack gap-32">
      <nav className="steps" aria-label="Progress">
        {(["ask", "spread", "draw"] as const).map((s, i) => (
          <span key={s} style={{ display: "contents" }}>
            {i > 0 && <span className="step-line" aria-hidden="true" />}
            <span className="step" aria-current={i === stepIndex ? "step" : undefined}>
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
          <h1 className="h1" tabIndex={-1} ref={headingRef}>{m.ask.title}</h1>
          <div className="stack gap-8">
            <label htmlFor="q" className="visually-hidden">{m.ask.title}</label>
            <textarea
              id="q"
              className="textarea"
              value={question}
              maxLength={MAX_QUESTION}
              placeholder={m.ask.placeholder}
              onChange={(e) => setQuestion(e.target.value)}
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
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={() => continueFromAsk()} disabled={!question.trim()}>{m.ask.continue}</button>
            <button type="button" className="btn-text" onClick={() => continueFromAsk(true)}>{m.ask.skip}</button>
          </div>
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
                <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span className="spread-diagram" aria-hidden="true">{SPREADS[id].positions.map((_, i) => <i key={i} />)}</span>
                  {question.trim() && id === suggested && <span className="badge">{m.spreads.suggested}</span>}
                </span>
                <span className="h3">{m.spreads[id].name}</span>
                <span className="muted small">{m.spreads[id].desc}</span>
                <span className="meta">{SPREADS[id].positions.map((p) => pick(p)).join(" · ")}</span>
              </button>
            ))}
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={!spread} onClick={() => { setPhase("shuffle"); setStep("draw"); }}>{m.ask.continue}</button>
            <button type="button" className="btn-text" onClick={() => setStep("ask")}>{m.common.back}</button>
          </div>
        </section>
      )}

      {step === "draw" && def && (
        <section className="stack gap-24">
          {question.trim() && <p className="quote">{question.trim()}</p>}

          {phase === "shuffle" && (
            <div className="stack gap-16" style={{ alignItems: "center", textAlign: "center" }}>
              <h1 className="h1" tabIndex={-1} ref={headingRef}>{m.draw.shuffleTitle}</h1>
              <p className="lede">{m.draw.shuffleHint}</p>
              <div className="shuffle-stage">
                <div className="shuffle-stack" data-active={shuffling} aria-hidden="true">
                  {[0, 1, 2, 3, 4].map((i) => <img key={i} src={CARD_BACK} alt="" style={{ transform: `translateY(${-i * 2}px)` }} />)}
                </div>
              </div>
              <button type="button" className="btn btn-primary" onClick={startShuffle} disabled={shuffling}>
                {shuffling ? m.draw.shuffling : m.draw.shuffle}
              </button>
            </div>
          )}

          {phase !== "shuffle" && dealt && (
            <>
              <div className="stack gap-8" style={{ textAlign: "center", alignItems: "center" }}>
                <h1 className="h1" tabIndex={-1} ref={headingRef}>
                  {phase === "pick" ? (def.count === 1 ? m.draw.pickTitleOne : fmt(m.draw.pickTitle, { n: def.count })) : m.draw.revealTitle}
                </h1>
                <p className="lede">{phase === "pick" ? m.draw.pickHint : m.draw.revealHint}</p>
                {phase === "pick" && <span className="meta">{fmt(m.draw.picked, { k: picks.length, n: def.count })}</span>}
              </div>

              {phase === "pick" && (
                <div className="fan" role="group" aria-label={phase}>
                  {Array.from({ length: FAN_SIZE }, (_, i) => {
                    const angle = -36 + (72 / (FAN_SIZE - 1)) * i;
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
              )}

              <div className="slots">
                {def.positions.map((pos, i) => {
                  const c = chosen[i];
                  return (
                    <div className="slot" key={i}>
                      {c ? (
                        <TarotCard
                          id={c.id}
                          reversed={c.reversed}
                          revealed={phase === "reveal" && revealed[i]}
                          label={`${pick(pos)} — ${phase === "reveal" && !revealed[i] ? m.common.reveal : ""}`}
                          onClick={phase === "reveal" ? () => flip(i) : undefined}
                        />
                      ) : (
                        <span className="slot-empty">{m.draw.slotEmpty}</span>
                      )}
                      <span className="meta">{pick(pos)}</span>
                    </div>
                  );
                })}
              </div>

              <div className="btn-row" style={{ justifyContent: "center" }}>
                {phase === "reveal" && !allRevealed && (
                  <button type="button" className="btn btn-ghost" onClick={revealAll}>{m.draw.revealAll}</button>
                )}
                {phase === "reveal" && allRevealed && (
                  <button type="button" className="btn btn-primary" onClick={finish}>{m.draw.seeReading}</button>
                )}
                <button type="button" className="btn-text" onClick={() => { setPhase("shuffle"); setDealt(null); setPicks([]); }}>{m.draw.reshuffle}</button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
