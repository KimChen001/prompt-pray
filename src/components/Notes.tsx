"use client";
// "What MOONA remembers": notes exist only when the person saves them. MOONA may suggest one from
// the person's own words (shown with the quote); nothing is stored until they confirm.
// Functional build; visual design pending.
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { deleteNote, listNotes, saveNote, saveReading, useStoreVersion } from "@/lib/store";
import { detectCrisis } from "@/lib/safety";
import { formatLocalDate, localDateKey } from "@/lib/time";
import { NOTE_MAX, type MemoryNote } from "@/lib/memory";
import type { ChatTurn, Reading } from "@/lib/tarot/types";
import { SupportPanel } from "./bits";

/** The notes a reading shares with the AI, resolved from the note store (deleted notes drop out). */
export function sharedNotes(reading: Reading): MemoryNote[] {
  if (!reading.noteIds?.length) return [];
  const all = listNotes();
  return reading.noteIds.map((id) => all.find((n) => n.id === id)).filter((n): n is MemoryNote => !!n);
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
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!text.trim()}
          onClick={() => (detectCrisis(text) ? setCrisis(true) : onSave(text.trim()))}
        >
          {saveLabel}
        </button>
        {onCancel && <button type="button" className="btn-text" onClick={onCancel}>{m.notes.cancel}</button>}
      </div>
    </div>
  );
}

/** Under an assistant turn: MOONA's suggestion, saved only if the person confirms (optionally edited). */
export function NoteSuggestion({ reading, turnIndex, onChange }: { reading: Reading; turnIndex: number; onChange: (r: Reading) => void }) {
  const { m, fmt } = useI18n();
  const [editing, setEditing] = useState(false);
  const turn = reading.thread![turnIndex];
  const s = turn.suggestion;
  if (!s) return null;

  function setStatus(status: "saved" | "dismissed", text = s!.text) {
    const thread = reading.thread!.map((t, i): ChatTurn => (i === turnIndex ? { ...t, suggestion: { ...s!, text, status } } : t));
    const next = { ...reading, thread };
    saveReading(next);
    onChange(next);
  }
  function confirm(text: string) {
    const now = new Date().toISOString();
    saveNote({ id: crypto.randomUUID(), text, origin: "suggested", quote: s!.quote, readingId: reading.id, createdAt: now, confirmedAt: now, updatedAt: now });
    setStatus("saved", text);
    setEditing(false);
  }

  if (s.status !== "pending") return <span className="muted small">{s.status === "saved" ? m.notes.saved : m.notes.dismissed}</span>;
  return (
    <div className="panel stack gap-8" role="group" aria-label={m.notes.suggestTitle}>
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
            <button type="button" className="btn-text" onClick={() => setStatus("dismissed")}>{m.notes.dismiss}</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Reading page: exactly which saved notes this reading shares with the AI, with a way to stop. */
export function SharedNotes({ reading, onChange }: { reading: Reading; onChange: (r: Reading) => void }) {
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
      <button
        type="button"
        className="btn-text"
        style={{ padding: 0, minHeight: 0 }}
        onClick={() => {
          const next = { ...reading, noteIds: [] };
          saveReading(next);
          onChange(next);
        }}
      >
        {m.notes.stopSharing}
      </button>
    </details>
  );
}

/** /me: view, add, edit and delete notes. */
export function NotesManager() {
  const { m, locale } = useI18n();
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
            <li key={n.id} className="panel stack gap-4">
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
                  <p style={{ margin: 0 }}>{n.text}</p>
                  <span className="muted small">
                    {n.origin === "typed" ? m.notes.originTyped : m.notes.originSuggested} · {formatLocalDate(localDateKey(new Date(n.confirmedAt)), locale)}
                  </span>
                  <div className="btn-row">
                    <button type="button" className="btn-text" style={{ padding: 0, minHeight: 0 }} onClick={() => setEditing(n.id)}>{m.notes.edit}</button>
                    <button type="button" className="btn-text" style={{ padding: 0, minHeight: 0 }} onClick={() => deleteNote(n.id)}>{m.notes.delete}</button>
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
