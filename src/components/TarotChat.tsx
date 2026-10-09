"use client";
// "Talk it through": a short conversation about one saved reading. The cards never change;
// the thread is saved on the reading in this browser. Functional build; visual design pending.
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { saveReading } from "@/lib/store";
import { detectCrisis } from "@/lib/safety";
import type { ChatTurn, Reading } from "@/lib/tarot/types";
import type { BigThreeNames } from "@/lib/astro/summary";
import { SourceBadge, SupportPanel } from "./bits";

const MAX_LEN = 800;
const MAX_SENT_TURNS = 12;

interface Props {
  reading: Reading;
  /** The interpretation text the user is looking at (AI or offline), sent so replies stay consistent. */
  shown: string;
  chart?: BigThreeNames;
  autoFocus?: boolean;
  /** The page already knows AI is unavailable here (503): say so up front instead of after a send. */
  aiUnavailable?: boolean;
  onChange: (r: Reading) => void;
}

export function TarotChat({ reading, shown, chart, autoFocus, aiUnavailable, onChange }: Props) {
  const { m, locale } = useI18n();
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "failed" | "needsAi" | "crisis">(aiUnavailable ? "needsAi" : "idle");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const thread = reading.thread ?? [];
  // Replies created after this view opened are "live"; older ones were read back from storage.
  const [freshFrom] = useState(thread.length);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (aiUnavailable) setState("needsAi");
  }, [aiUnavailable]);

  function update(next: ChatTurn[]) {
    const r = { ...reading, thread: next };
    saveReading(r);
    onChange(r);
  }

  async function send(turns: ChatTurn[]) {
    setState("sending");
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reading: { locale, spread: reading.spread, topic: reading.topic, question: reading.question, cards: reading.cards, chart: reading.includeChart ? chart : undefined },
          shown,
          messages: turns.slice(-MAX_SENT_TURNS).map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      if (res.status === 503) return setState("needsAi");
      const body = await res.json();
      if (body.code === "crisis") return setState("crisis");
      if (!res.ok) return setState("failed");
      update([...turns, { role: "assistant", content: body.reply, at: new Date().toISOString(), meta: body.meta }]);
      setState("idle");
    } catch {
      setState("failed");
    }
  }

  function submit() {
    const text = draft.trim();
    if (!text || state === "sending") return;
    if (detectCrisis(text)) return setState("crisis");
    const turns: ChatTurn[] = [...thread, { role: "user", content: text, at: new Date().toISOString() }];
    update(turns);
    setDraft("");
    void send(turns);
  }

  const lastIsUnanswered = thread.length > 0 && thread[thread.length - 1].role === "user";

  return (
    <section className="stack gap-12" aria-label={m.reading.talk}>
      {thread.length > 0 && (
        <ol className="chat" aria-live="polite">
          {thread.map((t, i) => (
            <li key={i} className={`chat-turn chat-${t.role}`}>
              <span className="meta">{t.role === "user" ? m.reading.you : "MOONA"}</span>
              <p style={{ margin: 0 }}>{t.content}</p>
              {t.role === "assistant" && t.meta && <SourceBadge source={i >= freshFrom ? "live" : "saved"} time={t.meta.generatedAt} title={t.meta.model} />}
            </li>
          ))}
        </ol>
      )}

      {state === "crisis" && <SupportPanel onEdit={() => setState("idle")} />}
      {state === "needsAi" && <p className="notice" style={{ margin: 0 }}>{m.reading.chatNeedsAi}</p>}
      {state === "failed" && (
        <p className="notice" style={{ margin: 0 }}>
          {m.reading.chatFailed}{" "}
          {lastIsUnanswered && <button type="button" className="btn-text" style={{ minHeight: 0, padding: 0 }} onClick={() => void send(thread)}>{m.reading.retrySend}</button>}
        </p>
      )}
      {state === "sending" && <p className="muted small" style={{ margin: 0 }}>{m.reading.aiLoading}</p>}

      {state !== "needsAi" && state !== "crisis" && (
        <div className="stack gap-8">
          <label htmlFor="chat-input" className="visually-hidden">{m.reading.chatPlaceholder}</label>
          <textarea
            id="chat-input"
            ref={inputRef}
            className="textarea"
            style={{ minHeight: 80 }}
            maxLength={MAX_LEN}
            value={draft}
            placeholder={m.reading.chatPlaceholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
          <div className="btn-row" style={{ justifyContent: "space-between" }}>
            <span className="muted small">{m.reading.chatNote}</span>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={!draft.trim() || state === "sending"}>{m.reading.send}</button>
          </div>
        </div>
      )}
    </section>
  );
}
