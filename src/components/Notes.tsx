"use client";
// "What MOONA remembers": notes exist only when the person saves them. MOONA may suggest one from
// the person's own words (shown with the quote); nothing is stored until they confirm. Every note
// shows where it came from and can be edited, paused (withdrawn from use) or deleted.
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { deleteNote, listNotes, patchReading, saveNote, useStoreVersion } from "@/lib/store";
import { detectCrisis } from "@/lib/safety";
import { formatLocalDate, localDateKey } from "@/lib/time";
import { NOTE_MAX, type MemoryNote } from "@/lib/memory";
import type { ChatTurn, Reading } from "@/lib/tarot/types";
import { SupportPanel } from "./bits";

/** The notes a reading shares with the AI, resolved from the note store (deleted or paused notes drop out). */
export function sharedNotes(reading: Reading): MemoryNote[] {
  if (!reading.noteIds?.length) return [];
  const all = listNotes();
  return reading.noteIds.map((id) => all.find((n) => n.id === id)).filter((n): n is MemoryNote => !!n && !n.paused);
}

function NoteEditor({ initial, onSave, onCancel, saveLabel }: { initial: string; onSave: (text: string) => void; onCancel?: () => void; saveLabel: string }) {
  const { m } = useI18n();
  const [text, setText] = useState(initial);
  const [crisis, setCrisis] = useState(false);
  if (crisis) return <SupportPanel onEdit={() => setCrisis(false)} />;
  return (
    <div className="stack gap-8">
      <input className="input" maxLength={NOTE_MAX} value={text} aria-label={m.notes.addLabel} placeholder={m.notes.addPlaceholder} onChange={(e) => setText(e.target.value)} />
      <div className="btn-row">
        <button type="button" className="btn btn-ghost" disabled={!text.trim()} onClick={() => (detectCrisis(text) ? setCrisis(true) : onSave(text.trim()))}>
          {saveLabel}
        </button>
        {onCancel && <button type="button" className="btn-text" onClick={onCancel}>{m.notes.cancel}</button>}
      </div>
    </div>
  );
}

/**
 * Under an assistant turn: MOONA's suggestion, saved only if the person confirms (optionally edited).
 * `source` records where the note came from; `onStatus` updates the turn in its own record.
 */
export function NoteSuggestion({ turn, source, onStatus }: { turn: ChatTurn; source: { readingId?: string; chatId?: string }; onStatus: (status: "saved" | "dismissed", text: string) => void }) {
  const { m, fmt } = useI18n();
  const [editing, setEditing] = useState(false);
  const s = turn.suggestion;
  if (!s) return null;

  function confirm(text: string) {
    const now = new Date().toISOString();
    saveNote({ id: crypto.randomUUID(), text, origin: "suggested", quote: s!.quote, ...source, createdAt: now, confirmedAt: now, updatedAt: now });
    onStatus("saved", text);
    setEditing(false);
  }

  if (s.status !== "pending") return <span className="muted small">{s.status === "saved" ? m.notes.saved : m.notes.dismissed}</span>;
  return (
    <div className="panel-quiet stack gap-8" role="group" aria-label={m.notes.suggestTitle} style={{ padding: 14 }}>
      <span className="meta">{m.notes.suggestTitle}</span>
      {editing ? (
        <NoteEditor initial={s.text} saveLabel={m.notes.save} onSave={confirm} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <p style={{ margin: 0 }}>{s.text}</p>
          <span className="muted small">{fmt(m.notes.fromYourWords, { quote: s.quote })}</span>
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={() => confirm(s.text)}>{m.notes.save}</button>
            <button type="button" className="btn-text" onClick={() => setEditing(true)}>{m.notes.edit}</button>
            <button type="button" className="btn-text" onClick={() => onStatus("dismissed", s.text)}>{m.notes.dismiss}</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Updates one assistant turn's suggestion inside a reading's thread (latest copy; no-op if deleted). */
export function setReadingSuggestion(readingId: string, turnAt: string, status: "saved" | "dismissed", text: string) {
  patchReading(readingId, (r) => ({
    ...r,
    thread: (r.thread ?? []).map((t): ChatTurn => (t.at === turnAt && t.role === "assistant" && t.suggestion ? { ...t, suggestion: { ...t.suggestion, text, status } } : t)),
  }));
}

/** Reading page: exactly which saved notes this reading shares with the AI, with a way to stop. */
export function SharedNotes({ reading }: { reading: Reading }) {
  const { m, fmt } = useI18n();
  const version = useStoreVersion();
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  useEffect(() => setNotes(sharedNotes(reading)), [reading, version]);
  if (!notes.length) return null;
  return (
    <details className="small">
      <summary className="meta" style={{ cursor: "pointer" }}>{fmt(m.notes.sharedTitle, { n: notes.length })}</summary>
      <ul style={{ margin: "8px 0", paddingLeft: 20, color: "var(--text-2)" }}>
        {notes.map((n) => <li key={n.id}>{n.text}</li>)}
      </ul>
      <button type="button" className="btn-link" onClick={() => patchReading(reading.id, (r) => ({ ...r, noteIds: [] }))}>
        {m.notes.stopSharing}
      </button>
    </details>
  );
}

/** Where a note came from, with a link when that record still exists on this device. */
function NoteSource({ n }: { n: MemoryNote }) {
  const { m, fmt, locale } = useI18n();
  const date = formatLocalDate(localDateKey(new Date(n.confirmedAt)), locale);
  const where = n.chatId ? (
    <Link href={`/talk/c/${n.chatId}`}>{m.notes.inConversation}</Link>
  ) : n.readingId ? (
    <Link href={`/tarot/r/${n.readingId}`}>{m.notes.inReading}</Link>
  ) : null;
  return (
    <span className="muted small">
      {n.origin === "typed" ? m.notes.originTyped : m.notes.originSuggested} · {date}
      {where && <> · {where}</>}
      {n.quote && <><br />{fmt(m.notes.fromYourWords, { quote: n.quote })}</>}
    </span>
  );
}

/** Journal: view, add, edit, pause/resume and delete notes. */
export function NotesManager() {
  const { m } = useI18n();
  const version = useStoreVersion();
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(0); // bump to reset the add form
  useEffect(() => setNotes(listNotes()), [version]);

  function add(text: string) {
    const now = new Date().toISOString();
    saveNote({ id: crypto.randomUUID(), text, origin: "typed", createdAt: now, confirmedAt: now, updatedAt: now });
    setAdding((n) => n + 1);
  }

  return (
    <section className="stack gap-12" aria-labelledby="notes-title">
      <h2 className="h2" id="notes-title">{m.notes.sectionTitle}</h2>
      <p className="muted small" style={{ margin: 0 }}>{m.notes.sectionIntro}</p>
      {notes.length === 0 && <p className="muted" style={{ margin: 0 }}>{m.notes.empty}</p>}
      {notes.length > 0 && (
        <ul className="stack gap-8" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {notes.map((n) => (
            <li key={n.id} className="panel stack gap-8" data-paused={n.paused ? "true" : undefined} style={n.paused ? { opacity: 0.75 } : undefined}>
              {editing === n.id ? (
                <NoteEditor
                  initial={n.text}
                  saveLabel={m.notes.saveEdit}
                  onCancel={() => setEditing(null)}
                  onSave={(text) => {
                    saveNote({ ...n, text, updatedAt: new Date().toISOString() });
                    setEditing(null);
                  }}
                />
              ) : (
                <>
                  <div className="row-between" style={{ alignItems: "flex-start" }}>
                    <p style={{ margin: 0, flex: 1, minWidth: 0 }}>{n.text}</p>
                    {n.paused && <span className="badge">{m.notes.pausedBadge}</span>}
                  </div>
                  <NoteSource n={n} />
                  <div className="btn-row" style={{ gap: 16 }}>
                    <button type="button" className="btn-link" onClick={() => setEditing(n.id)}>{m.notes.edit}</button>
                    <button type="button" className="btn-link" onClick={() => saveNote({ ...n, paused: !n.paused, updatedAt: new Date().toISOString() })}>{n.paused ? m.notes.resume : m.notes.pause}</button>
                    <button type="button" className="btn-link" onClick={() => window.confirm(m.notes.confirmDelete) && deleteNote(n.id)}>{m.notes.delete}</button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <NoteEditor key={adding} initial="" saveLabel={m.notes.add} onSave={add} />
    </section>
  );
}
