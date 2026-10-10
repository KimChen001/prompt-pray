"use client";
// "Continue with these cards": a conversation about one saved reading. The cards never change; the
// thread is saved on the reading in this browser. Replies are added to the latest copy of the reading
// and only if the message they answer is still the newest, so a late reply can't overwrite newer
// messages, a withdrawn note, another language's interpretation, or a deleted reading.
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { appendReply, dataEpoch, listNotes, patchReading, useStoreVersion } from "@/lib/store";
import { hasSimilarNote, type MemoryNote } from "@/lib/memory";
import { detectCrisis } from "@/lib/safety";
import { windowMessages } from "@/lib/chat/limits";
import type { ChatTurn, Reading } from "@/lib/tarot/types";
import type { BigThreeNames } from "@/lib/astro/summary";
import { SupportPanel } from "./bits";
import { newRequestId, requestAiOnce } from "@/lib/ai/client";
import { CreditMeter } from "./packs/PacksPanel";

// When the pack's follow-ups for this reading can't be used, replies go back to the free allowance.
const PACK_GONE = new Set(["no_followups", "lot_closed", "no_such_reading", "reading_mismatch"]);
import { setReadingSuggestion, sharedNotes } from "./Notes";
import { ChatThread, Composer } from "./chat/ChatParts";

interface Props {
  reading: Reading;
  /** The interpretation text the user is looking at (AI or offline), sent so replies stay consistent. */
  shown: string;
  chart?: BigThreeNames;
  autoFocus?: boolean;
  /** The page already knows AI is unavailable here (503): say so up front instead of after a send. */
  aiUnavailable?: boolean;
  /** Reports request state, so the page's orb can pulse while MOONA is replying. */
  onBusy?: (busy: boolean) => void;
}

export function TarotChat({ reading, shown, chart, autoFocus, aiUnavailable, onBusy }: Props) {
  const { m, fmt, locale } = useI18n();
  const version = useStoreVersion();
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "failed" | "needsAi" | "crisis">(aiUnavailable ? "needsAi" : "idle");
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  // Why replies are off or failed, when the server said (quota, budget, paused, busy).
  const [notice, setNotice] = useState<string | null>(null);
  const thread = reading.thread ?? [];
  // Replies created after this view opened are "live"; older ones were read back from storage.
  const [freshFrom] = useState(thread.length);
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => setNotes(listNotes()), [version]);
  useEffect(() => {
    // follows the page: when its AI comes back (e.g. a pack reading just arrived), the chat opens again
    setState((s) => (aiUnavailable ? "needsAi" : s === "needsAi" ? "idle" : s));
  }, [aiUnavailable]);
  useEffect(() => () => inflight.current?.abort(), []);
  useEffect(() => onBusy?.(state === "sending"), [state, onBusy]);

  // A pack reading's follow-ups, while some are left (spec §10.2). They are tied to the spread, not
  // the language, so they work after a language switch too.
  const packOf = (r: Reading) => (r.paid?.paidReadingId && (r.paid.followupsLeft ?? 0) > 0 ? r.paid : null);

  async function send(r: Reading, free = false) {
    const pack = free ? null : packOf(r);
    const turns = r.thread ?? [];
    const answered = turns[turns.length - 1];
    const messages = windowMessages(turns);
    if (!answered || answered.role !== "user" || !messages.length) return;
    const ctrl = new AbortController();
    inflight.current?.abort();
    inflight.current = ctrl;
    const epoch = dataEpoch();
    // The id is kept on the message it answers, so sending again replays a reply already paid for.
    const remember = (requestId: string) => patchReading(r.id, (latest) => ({ ...latest, thread: (latest.thread ?? []).map((t) => (t.at === answered.at && t.role === "user" ? { ...t, requestId } : t)) }));
    const requestId = answered.requestId ?? newRequestId();
    if (!answered.requestId) remember(requestId);
    setState("sending");
    setNotice(null);
    try {
      const out = await requestAiOnce<{ reply?: unknown; remember?: unknown; meta?: ChatTurn["meta"] }>("/api/ai/chat", {
        reading: {
          locale, spread: r.spread, topic: r.topic, question: r.question, cards: r.cards,
          chart: r.includeChart ? chart : undefined,
          notes: sharedNotes(r).map((n) => n.text),
        },
        shown,
        messages,
        ...(pack ? { paidReadingId: pack.paidReadingId } : {}),
      }, { requestId, signal: ctrl.signal, onNewId: remember });
      if (pack && out.state === "failed" && PACK_GONE.has(out.code)) {
        // the pack's follow-ups are used (or its pack was refunded): say so, and answer from the free allowance
        const next = patchReading(r.id, (latest) => (latest.paid ? { ...latest, paid: { ...latest.paid, followupsLeft: 0 } } : latest));
        setNotice(m.packs.followupsDone);
        if (next) queueMicrotask(() => void send(next, true));
        return;
      }
      const stop = (next: "failed" | "needsAi", why: string | null = null) => {
        setNotice(why);
        setState(next);
      };
      if (out.state === "crisis") return setState("crisis");
      if (out.state === "quota") return stop("needsAi", m.aiNotice.quotaShort);
      if (out.state === "offline") {
        if (out.reason === "busy") return stop("failed", m.aiNotice.busyShort);
        if (out.reason === "network") return stop("failed");
        return stop("needsAi", out.reason === "budget" ? m.aiNotice.budgetShort : out.reason === "ledger" || out.reason === "paused" ? m.aiNotice.pausedShort : null);
      }
      if (out.state !== "done" || typeof out.value.reply !== "string") return setState("failed");
      const body = out.value;
      if (epoch !== dataEpoch()) return;
      if (pack && out.paid) patchReading(r.id, (latest) => (latest.paid ? { ...latest, paid: { ...latest.paid, followupsLeft: out.paid!.followupsLeft } } : latest));
      // A suggestion is only offered; it becomes a note if the person saves it.
      const s = body.remember as { text: string; quote: string } | null | undefined;
      const suggestion = s && !hasSimilarNote(listNotes(), s.text) ? { text: s.text, quote: s.quote, status: "pending" as const } : undefined;
      const reply: ChatTurn = { role: "assistant", content: body.reply as string, at: new Date().toISOString(), meta: body.meta, ...(suggestion ? { suggestion } : {}) };
      patchReading(r.id, (latest) => {
        const next = appendReply(latest.thread ?? [], answered, reply);
        return next ? { ...latest, thread: next } : latest;
      });
      setState("idle");
    } catch {
      if (!ctrl.signal.aborted) setState("failed");
    } finally {
      if (inflight.current === ctrl) inflight.current = null;
    }
  }

  function submit() {
    const text = draft.trim();
    if (!text || state === "sending") return;
    if (detectCrisis(text)) return setState("crisis");
    const next = patchReading(reading.id, (latest) => ({ ...latest, thread: [...(latest.thread ?? []), { role: "user", content: text, at: new Date().toISOString(), requestId: newRequestId() }] }));
    if (!next) return;
    setDraft("");
    void send(next);
  }

  function undoLast() {
    inflight.current?.abort();
    const last = thread[thread.length - 1];
    if (!last || last.role !== "user") return;
    patchReading(reading.id, (latest) => ({ ...latest, thread: (latest.thread ?? []).filter((t) => t.at !== last.at) }));
    setDraft(last.content);
    setState("idle");
  }

  const lastIsUnanswered = thread.length > 0 && thread[thread.length - 1].role === "user";

  return (
    <section className="stack gap-3" aria-label={m.reading.talk}>
      <ChatThread turns={thread} freshFrom={freshFrom} notes={notes} source={{ readingId: reading.id }} onSuggestion={(at, status, text) => setReadingSuggestion(reading.id, at, status, text)} />

      {state === "sending" && (
        <div className="row" aria-live="polite">
          <span className="status-line"><span className="status-dot" />{m.reading.aiReplying}</span>
          <button type="button" className="btn-link" onClick={undoLast}>{m.talk.undo}</button>
        </div>
      )}
      {state === "crisis" && <SupportPanel onEdit={() => setState("idle")} />}
      {state === "needsAi" && <p className="notice">{notice ?? m.reading.chatNeedsAi}</p>}
      {(state === "failed" || (state === "idle" && lastIsUnanswered)) && (
        <p className="notice">
          {state === "failed" ? notice ?? m.reading.chatFailed : m.talk.unanswered}{" "}
          <button type="button" className="btn-link" onClick={() => void send(reading)}>{m.reading.retrySend}</button>
          {" · "}
          <button type="button" className="btn-link" onClick={undoLast}>{m.talk.editLast}</button>
        </p>
      )}

      {packOf(reading) && <CreditMeter left={reading.paid!.followupsLeft!} total={Math.max(reading.paid!.followupsTotal ?? 0, reading.paid!.followupsLeft!)} label={fmt(m.packs.followupsMeter, { n: reading.paid!.followupsLeft! })} />}
      {!packOf(reading) && reading.paid?.paidReadingId && <span className="muted small">{m.packs.followupsDone}</span>}
      {state !== "needsAi" && state !== "crisis" && (
        <div className="stack gap-2">
          <Composer id="reading-chat" value={draft} onChange={setDraft} onSend={submit} disabled={state === "sending"} placeholder={m.reading.chatPlaceholder} label={m.reading.chatPlaceholder} autoFocus={autoFocus} />
          <span className="muted small">{m.reading.chatNote}</span>
        </div>
      )}
    </section>
  );
}
