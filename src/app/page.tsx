"use client";
// Ask — the home page, ported from the team's Figma Make prototype (github.com/KimChen001/Moona,
// src/app/App.tsx): the orb in the starfield, "What's on your mind tonight?", three prompts and one
// input; once you start, the orb shrinks and rises and the conversation fills the space.
// Everything the prototype faked is real here:
//   - typed messages are a real Talk conversation (/api/ai/talk), saved on this device and continued
//     in Talk; without AI it says so plainly and offers a card instead,
//   - "Draw a card for today" is the real daily card (same card all day, saved),
//   - "How is the Moon tonight?" is calculated from the real sky for this time zone,
//   - "What should I let go of?" is a real one-card reading from the 78-card deck, saved, with the full
//     interpretation one tap away,
//   - "Save" means saved on this device (there are no accounts yet).
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowUp, Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useMotionLevel } from "@/lib/motion";
import {
  activeNotes, appendReply, createChat, dataEpoch, getBirth, getChat, getDaily, getDeviceId, getSettings, listChats, listCheckIns, listNotes, listReadings,
  patchChat, recordVisit, saveDaily, saveReading,
} from "@/lib/store";
import { checkInsDue, hasSimilarNote } from "@/lib/memory";
import { newRequestId, requestAiOnce } from "@/lib/ai/client";
import { detectCrisis } from "@/lib/safety";
import { windowMessages } from "@/lib/chat/limits";
import { newSession, type ChatContextChoice } from "@/lib/chat/session";
import { talkBody } from "@/lib/chat/context";
import { greetingFor } from "@/lib/greeting";
import { dailyCard } from "@/lib/tarot/daily";
import { DECK, cardImage, getCard } from "@/lib/tarot/deck";
import { randomSeed, rngFromSeed, shuffle } from "@/lib/tarot/rng";
import { firstSentence } from "@/lib/tarot/engine";
import { skyForDay } from "@/lib/astro/sky";
import { SIGN_INFO } from "@/lib/astro/zodiac";
import { formatLocalDate, localDateKey, userTimeZone } from "@/lib/time";
import type { AiMeta, BasisItem, ChatTurn, DrawnCard, Reading } from "@/lib/tarot/types";
import { Orb } from "@/components/cosmos/Orb";
import { Whispers } from "@/components/cosmos/Whispers";
import { SupportPanel } from "@/components/bits";

type CardInfo = { id: string; reversed: boolean; href: string; daily: boolean };
type MoonInfo = { phase: string; lit: number; sign: string; hint: string; next: string };
type Msg =
  | { from: "me"; text: string }
  | { from: "moona"; kind: "text"; text: string; meta?: AiMeta; basis?: BasisItem[] }
  | { from: "moona"; kind: "card"; text: string; card: CardInfo }
  | { from: "moona"; kind: "moon"; text: string; moon: MoonInfo }
  | { from: "moona"; kind: "notice"; text: string; offerCard?: boolean; retry?: boolean }
  | { from: "moona"; kind: "support" };

const CONTEXT: ChatContextChoice = { chart: false, today: true, noteIds: [] };

export default function AskPage() {
  const { m, fmt, pick, locale } = useI18n();
  const level = useMotionLevel();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const [greeting, setGreeting] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { listRef.current?.scrollTo({ top: 1e6, behavior: level === "full" ? "smooth" : "auto" }); }, [msgs, thinking, level]);

  // A quiet line for someone coming back, built only from what is saved on this device.
  useEffect(() => {
    const previous = recordVisit();
    const today = localDateKey();
    const g = greetingFor({ previousVisitLocal: previous ? localDateKey(new Date(previous)) : null, todayLocal: today, dueCheckIns: checkInsDue(listCheckIns(), today).due, readings: listReadings(), chats: listChats() });
    if (g.kind === "checkin") setGreeting(`${m.greeting.checkin} “${g.checkIn.action}”`);
    else if (g.kind === "reading") setGreeting(fmt(m.greeting.reading, { spread: m.spreads[g.reading.spread].name, date: formatLocalDate(g.reading.localDate, locale) }));
    else if (g.kind === "chat") setGreeting(`${m.greeting.chat} “${g.chat.title}”`);
    else if (g.kind === "back") setGreeting(m.greeting.back);
    else setGreeting(null);
  }, [m, fmt, locale]);

  const push = (x: Msg) => setMsgs((list) => [...list, x]);

  /** A typed message: a real conversation with MOONA. */
  async function talk(text: string) {
    if (detectCrisis(text)) {
      push({ from: "me", text });
      return push({ from: "moona", kind: "support" });
    }
    const at = new Date().toISOString();
    // Continue this page's conversation; if it was deleted meanwhile (in another tab), start a new one.
    let id = chatId && patchChat(chatId, (s) => ({ ...s, turns: [...s.turns, { role: "user", content: text, at }], updatedAt: at })) ? chatId : null;
    if (!id) {
      const session = newSession(crypto.randomUUID(), text, CONTEXT);
      createChat(session);
      id = session.id;
      setChatId(id);
    }
    push({ from: "me", text });
    await requestReply(id);
  }

  async function requestReply(id: string) {
    const session = getChat(id);
    if (!session) return;
    const answered = session.turns[session.turns.length - 1];
    const messages = windowMessages(session.turns);
    if (!messages.length) return;
    setThinking(true);
    const epoch = dataEpoch();
    try {
      const body = talkBody(session, locale, { birth: getBirth(), houseSystem: getSettings().houseSystem, notes: activeNotes(), today: { date: localDateKey(), timeZone: userTimeZone() } }, messages);
      // The id is kept on the message it answers, so a retry replays a reply already paid for.
      const remember = (requestId: string) => patchChat(id, (s) => ({ ...s, turns: s.turns.map((t) => (t.at === answered.at && t.role === "user" ? { ...t, requestId } : t)) }));
      const requestId = answered.requestId ?? newRequestId();
      if (!answered.requestId) remember(requestId);
      const out = await requestAiOnce<{ reply?: string; basis?: BasisItem[]; remember?: { text: string; quote: string } | null; meta?: AiMeta }>("/api/ai/talk", body as unknown as Record<string, unknown>, { requestId, onNewId: remember });
      if (out.state === "crisis") return push({ from: "moona", kind: "support" });
      if (out.state === "quota") return push({ from: "moona", kind: "notice", text: m.aiNotice.quotaShort, offerCard: true });
      if (out.state === "offline" && out.reason !== "network") {
        const why = out.reason === "busy" ? m.aiNotice.busyShort : out.reason === "budget" ? m.aiNotice.budgetShort : out.reason === "ledger" || out.reason === "paused" ? m.aiNotice.pausedShort : m.cosmos.noAi;
        return push({ from: "moona", kind: "notice", text: why, offerCard: true, ...(out.reason === "busy" ? { retry: true } : {}) });
      }
      if (out.state !== "done" || !out.value.reply) return push({ from: "moona", kind: "notice", text: m.talk.failed, retry: true });
      const data = out.value as { reply: string; basis?: BasisItem[]; remember?: { text: string; quote: string } | null; meta?: AiMeta };
      if (epoch !== dataEpoch()) return;
      const suggestion = data.remember && !hasSimilarNote(listNotes(), data.remember.text) ? { ...data.remember, status: "pending" as const } : undefined;
      const reply: ChatTurn = { role: "assistant", content: data.reply, at: new Date().toISOString(), meta: data.meta, basis: data.basis, ...(suggestion ? { suggestion } : {}) };
      const applied = patchChat(id, (s) => {
        const next = appendReply(s.turns, answered, reply);
        return next ? { ...s, turns: next, updatedAt: reply.at } : s;
      });
      if (applied) push({ from: "moona", kind: "text", text: data.reply, meta: data.meta, basis: data.basis });
    } catch {
      push({ from: "moona", kind: "notice", text: m.talk.failed, retry: true });
    } finally {
      setThinking(false);
    }
  }

  /** "Draw a card for today": the real daily card for this device and day. */
  function todayCard() {
    const date = localDateKey();
    let card = getDaily(date, "general");
    if (!card) {
      card = dailyCard(getDeviceId(), date, "general", getSettings().reversals);
      saveDaily(date, "general", card);
      saveReading({ id: `daily-${date}-general`, kind: "daily", createdAt: new Date().toISOString(), localDate: date, spread: "single", topic: "general", cards: [card], seed: `daily|${date}|general` });
    }
    push({ from: "moona", kind: "card", text: m.cosmos.drewToday, card: { id: card.id, reversed: card.reversed, href: "/today", daily: true } });
  }

  /** "How is the Moon tonight?": calculated from the real sky. */
  function moonTonight() {
    const tz = userTimeZone();
    const sky = skyForDay(localDateKey(), tz, new Date());
    const next = sky.next[0];
    push({
      from: "moona", kind: "moon", text: m.cosmos.moonIntro,
      moon: {
        phase: m.sky.phases[sky.moon.phase],
        lit: Math.round(sky.moon.illumination * 100),
        sign: pick(SIGN_INFO[sky.moon.placement.sign].name),
        hint: m.cosmos.phaseHints[sky.moon.phase],
        next: fmt(m.sky.next, { phase: m.sky.phases[next.phase], when: formatLocalDate(localDateKey(next.at, tz), locale) }),
      },
    });
  }

  /** A real one-card reading for a question, saved on this device. */
  function drawFor(question: string) {
    const seed = randomSeed();
    const rng = rngFromSeed(seed);
    const allowReversed = getSettings().reversals;
    const deck = shuffle(DECK, rng).map((c): DrawnCard => ({ id: c.id, reversed: allowReversed && rng() < 0.5 }));
    const drawn = deck[Math.floor(rng() * deck.length)];
    const reading: Reading = { id: randomSeed(), kind: "reading", createdAt: new Date().toISOString(), localDate: localDateKey(), spread: "single", topic: "growth", question, cards: [drawn], seed };
    saveReading(reading);
    push({ from: "moona", kind: "card", text: m.cosmos.drewOne, card: { id: drawn.id, reversed: drawn.reversed, href: `/tarot/r/${reading.id}`, daily: false } });
  }

  function prompt(i: number) {
    const text = m.cosmos.prompts[i];
    push({ from: "me", text });
    if (i === 0) todayCard();
    else if (i === 1) moonTonight();
    else drawFor(text);
  }

  function send(text: string) {
    const t = text.trim();
    if (!t || thinking) return;
    setInput("");
    void talk(t);
  }

  const started = msgs.length > 0;

  return (
    <>
      <Whispers paused={started} />
      <div className={`flex flex-col items-center transition-all duration-1000 ${started ? "pt-0" : "pt-[3vh]"}`}>
        <Orb small={started} />
        <AnimatePresence>
          {!started && (
            <motion.div
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10, filter: "blur(6px)" }}
              transition={{ duration: level === "full" ? 0.9 : 0, delay: level === "full" ? 0.3 : 0 }}
              className="-mt-2 px-6 text-center"
            >
              <h1 className="m-0 font-serif-i text-4xl font-normal leading-tight sm:text-5xl">
                {m.cosmos.headlineA}<em className="text-white/60">{m.cosmos.headlineEm}</em>{m.cosmos.headlineB}
              </h1>
              {greeting && <p className="mx-auto mb-0 mt-3 max-w-[30rem] text-[13px] leading-relaxed text-white/45">{greeting}</p>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className={`mx-auto mt-auto flex w-full max-w-[550px] flex-col px-3 pb-3 sm:pb-6 ${started ? "-mt-24 min-h-0 flex-1" : ""}`}>
        {started && (
          <div ref={listRef} className="no-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-4 pt-24 [mask-image:linear-gradient(to_bottom,transparent,black_12%)]" aria-live="polite">
            <div className="flex-1" />
            {msgs.map((x, i) => (
              <motion.div key={i} initial={{ opacity: 0, y: level === "full" ? 8 : 0 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: level === "full" ? 0.6 : 0 }}
                className={x.from === "me" ? "max-w-[80%] self-end" : "max-w-[88%] self-start"}>
                {x.from === "me" ? (
                  <p className="m-0 rounded-2xl rounded-br-sm bg-white/[0.08] px-4 py-2.5 text-[15px]">{x.text}</p>
                ) : x.kind === "support" ? (
                  <SupportPanel />
                ) : (
                  <div className="space-y-3">
                    <p className="m-0 whitespace-pre-wrap text-[15px] text-white/75">{x.text}</p>
                    {x.kind === "text" && x.meta && (
                      <p className="m-0 font-mono-g text-[10px] uppercase tracking-[0.18em] text-[#5ee6d0]/80">{m.badge.live}</p>
                    )}
                    {x.kind === "card" && <CardPanel card={x.card} />}
                    {x.kind === "moon" && <MoonPanel moon={x.moon} />}
                    {x.kind === "notice" && (
                      <div className="flex flex-wrap gap-2">
                        {x.offerCard && <button type="button" onClick={() => prompt(0)} className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-[13px] text-white/75 transition-colors hover:border-[#c9a96e]/50 hover:text-white">{m.cosmos.prompts[0]}</button>}
                        {x.retry && chatId && <button type="button" onClick={() => void requestReply(chatId)} className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-[13px] text-white/75 transition-colors hover:border-[#c9a96e]/50 hover:text-white">{m.talk.retry}</button>}
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            ))}
            {thinking && (
              <div className="flex gap-1.5 self-start px-1 py-2" role="status" aria-label={m.talk.thinking}>
                {[0, 1, 2].map((d) => (
                  <motion.span key={d} className="h-1.5 w-1.5 rounded-full bg-white/50" animate={{ opacity: [0.2, 1, 0.2] }} transition={{ duration: 1.4, repeat: Infinity, delay: d * 0.2 }} />
                ))}
              </div>
            )}
            {chatId && (
              <Link href={`/talk/c/${chatId}`} className="self-start font-mono-g text-[10px] uppercase tracking-[0.2em] text-white/40 no-underline hover:text-white">{m.cosmos.continueTalk} →</Link>
            )}
          </div>
        )}

        {!started && (
          <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto px-1 sm:flex-wrap sm:justify-center sm:overflow-visible">
            {m.cosmos.prompts.map((p, i) => (
              <button key={p} type="button" onClick={() => prompt(i)}
                className="shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-[13px] text-white/65 backdrop-blur-md transition-colors hover:border-[#c9a96e]/50 hover:text-white">
                {p}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); send(input); }}
          className="flex items-end gap-2 rounded-3xl border border-white/[0.08] bg-[#0d0b16]/70 p-2 pl-5 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] backdrop-blur-xl focus-within:border-white/20">
          <label htmlFor="ask-input" className="visually-hidden">{m.cosmos.placeholder}</label>
          <input id="ask-input" value={input} maxLength={800} onChange={(e) => setInput(e.target.value)} placeholder={m.cosmos.placeholder} enterKeyHint="send" autoComplete="off"
            className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-[16px] text-white outline-none placeholder:text-white/30" />
          <button type="submit" disabled={!input.trim() || thinking}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border-0 bg-[#ece8f4] text-[#07060c] transition-opacity disabled:opacity-20" aria-label={m.reading.send}>
            <ArrowUp size={17} strokeWidth={1.75} />
          </button>
        </form>
        <p className="mb-0 mt-3 hidden text-center font-mono-g text-[10px] uppercase tracking-[0.25em] text-white/30 sm:block">{m.cosmos.free}</p>
      </div>
    </>
  );
}

/** A card MOONA drew, in the prototype's card panel — with the real card art and its one-line message. */
function CardPanel({ card }: { card: CardInfo }) {
  const { m, pick } = useI18n();
  const data = getCard(card.id);
  const side = card.reversed ? data.reversed : data.upright;
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4 backdrop-blur-md">
      <div className="flex gap-4">
        <div className="h-24 w-16 shrink-0 overflow-hidden rounded-md border border-[#c9a96e]/40 bg-[radial-gradient(circle_at_50%_35%,rgba(140,120,255,0.35),#0d0b18_70%)]">
          <img src={cardImage(card.id)} alt="" className={`h-full w-full object-cover ${card.reversed ? "rotate-180" : ""}`} />
        </div>
        <div>
          <p className="m-0 font-serif-i text-2xl leading-none">{pick(data.name)}</p>
          {card.reversed && <p className="m-0 mt-1 font-mono-g text-[10px] uppercase tracking-[0.2em] text-[#c9a96e]/80">{m.common.reversed}</p>}
          <p className="m-0 mt-2 text-sm leading-relaxed text-white/65">{firstSentence(pick(side.meaning))}</p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
        <Link href={card.href} className="text-[13px] text-white/65 no-underline transition-colors hover:text-white">{card.daily ? m.cosmos.openToday : m.cosmos.openReading} →</Link>
        <span className="flex items-center gap-2 text-[13px] text-[#c9a96e]">
          <Check size={14} strokeWidth={1.5} aria-hidden="true" />{m.cosmos.savedHere}
        </span>
      </div>
    </div>
  );
}

/** Tonight's Moon, calculated — in the same panel style. */
function MoonPanel({ moon }: { moon: MoonInfo }) {
  const { m, fmt } = useI18n();
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4 backdrop-blur-md">
      <p className="m-0 font-serif-i text-2xl leading-none">{moon.phase}</p>
      <p className="m-0 mt-1 font-mono-g text-[10px] uppercase tracking-[0.2em] text-white/45">{fmt(m.cosmos.lit, { n: moon.lit })} · {fmt(m.sky.moonIn, { sign: moon.sign })}</p>
      <p className="m-0 mt-3 text-sm leading-relaxed text-white/65">{moon.hint}</p>
      <p className="m-0 mt-2 text-[13px] text-white/45">{moon.next}</p>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
        <Link href="/today" className="text-[13px] text-white/65 no-underline transition-colors hover:text-white">{m.cosmos.openSky} →</Link>
        <span className="font-mono-g text-[10px] uppercase tracking-[0.18em] text-white/35">{m.badge.calc}</span>
      </div>
    </div>
  );
}
