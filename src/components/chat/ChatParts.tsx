"use client";
// Shared conversation UI: the thread (with source badges, "based on" chips and note suggestions) and
// the composer (soft-keyboard friendly, IME-safe Enter handling).
import { useEffect, useRef, type KeyboardEvent } from "react";
import { useI18n } from "@/lib/i18n";
import { CHAT_LIMITS } from "@/lib/chat/limits";
import type { MemoryNote } from "@/lib/memory";
import type { BasisItem, ChatTurn } from "@/lib/tarot/types";
import { SourceBadge } from "../bits";
import { NoteSuggestion } from "../Notes";

export function BasisChips({ basis, notes }: { basis: BasisItem[]; notes: MemoryNote[] }) {
  const { m } = useI18n();
  if (!basis.length) return null;
  return (
    <div className="chat-basis" aria-label={m.talk.basedOn}>
      <span className="chat-who" style={{ alignSelf: "center" }}>{m.talk.basedOn}</span>
      {basis.map((b) => {
        // Notes are resolved now, so a deleted note leaves no text behind in old replies.
        const label = b.kind === "said" ? notes.find((n) => `note.${n.id}` === b.id)?.text ?? m.talk.noteGone : b.label;
        return (
          <span key={b.id} className="basis-chip" data-kind={b.kind}>
            <b>{b.kind === "said" ? m.talk.kindSaid : m.talk.kindCalc}</b>
            {label}
          </span>
        );
      })}
    </div>
  );
}

export function ChatThread({
  turns, freshFrom, notes, source, onSuggestion,
}: {
  turns: ChatTurn[];
  /** Replies at or after this index arrived in this view ("Live AI"); earlier ones were saved. */
  freshFrom: number;
  notes: MemoryNote[];
  source: { readingId?: string; chatId?: string };
  onSuggestion: (turnAt: string, status: "saved" | "dismissed", text: string) => void;
}) {
  const { m } = useI18n();
  if (!turns.length) return null;
  return (
    <ol className="chat" aria-live="polite">
      {turns.map((t, i) => (
        <li key={`${t.at}-${i}`} className={`chat-turn chat-${t.role}`}>
          <span className="chat-who">{t.role === "user" ? m.reading.you : "MOONA"}</span>
          <p>{t.content}</p>
          {t.role === "assistant" && (
            <>
              {t.basis && <BasisChips basis={t.basis} notes={notes} />}
              {t.meta && <SourceBadge source={i >= freshFrom ? "live" : "saved"} time={t.meta.generatedAt} title={t.meta.model} />}
              {t.suggestion && <NoteSuggestion turn={t} source={source} onStatus={(status, text) => onSuggestion(t.at, status, text)} />}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

function coarsePointer() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
}

export function Composer({
  value, onChange, onSend, disabled, placeholder, label, autoFocus, id = "chat-input",
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder: string;
  label: string;
  autoFocus?: boolean;
  id?: string;
}) {
  const { m } = useI18n();
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && !coarsePointer()) ref.current?.focus();
  }, [autoFocus]);

  // Grow with the text up to a limit (CSS caps it at 40% of the visible height).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends on keyboards; on phones Return adds a line and the button sends. Never while an
    // input method (Chinese, Japanese…) is composing.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (coarsePointer() && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (!disabled && value.trim()) onSend();
  }

  return (
    <div className="stack gap-8">
      <div className="composer">
        <label htmlFor={id} className="visually-hidden">{label}</label>
        <textarea
          id={id}
          ref={ref}
          className="textarea"
          rows={1}
          maxLength={CHAT_LIMITS.userMax}
          value={value}
          placeholder={placeholder}
          enterKeyHint="send"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="btn btn-primary" onClick={onSend} disabled={disabled || !value.trim()}>{m.reading.send}</button>
      </div>
      {value.length > CHAT_LIMITS.userMax - 80 && <span className="meta" style={{ alignSelf: "flex-end" }}>{value.length} / {CHAT_LIMITS.userMax}</span>}
    </div>
  );
}
