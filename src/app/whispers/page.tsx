"use client";
// Whispers. Today: a private place to write things down, kept only on this device; nothing is sent
// anywhere unless the person chooses "Talk about this" (which only fills the Talk box). The shared
// wall stays in scope but is clearly marked as not live: no posts, no counts, no simulated activity.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { deleteWhisper, listWhispers, saveWhisper, useStoreVersion, type WhisperEntry } from "@/lib/store";
import { detectCrisis } from "@/lib/safety";
import { PRIVATE_MAX, WALL_DECISIONS } from "@/lib/whispers/policy";
import { formatLocalDate, localDateKey } from "@/lib/time";
import { SupportPanel } from "@/components/bits";
import { TALK_DRAFT_KEY } from "@/lib/chat/session";

export default function WhispersPage() {
  const { m, locale } = useI18n();
  const router = useRouter();
  const version = useStoreVersion();
  const [entries, setEntries] = useState<WhisperEntry[]>([]);
  const [text, setText] = useState("");
  const [crisis, setCrisis] = useState(false);
  useEffect(() => setEntries(listWhispers()), [version]);

  function save() {
    const t = text.trim();
    if (!t) return;
    if (detectCrisis(t)) return setCrisis(true);
    const now = new Date().toISOString();
    saveWhisper({ id: crypto.randomUUID(), text: t, createdAt: now, updatedAt: now });
    setText("");
  }

  function talkAbout(e: WhisperEntry) {
    // Prefills the Talk box on this device only (session storage, never the URL); the person still decides to send.
    try {
      window.sessionStorage.setItem(TALK_DRAFT_KEY, e.text.slice(0, 800));
    } catch {
      /* storage blocked: open Talk empty */
    }
    router.push("/talk");
  }

  return (
    <div className="stack gap-32" style={{ maxWidth: 820 }}>
      <header className="page-head">
        <p className="eyebrow">{m.nav.whispers}</p>
        <h1 className="h1">{m.whispers.title}</h1>
        <p className="lede">{m.whispers.intro}</p>
      </header>

      <section className="panel stack gap-12" aria-labelledby="write-title">
        <div className="row-between">
          <h2 className="h3" id="write-title">{m.whispers.writeTitle}</h2>
          <span className="badge">{m.whispers.privateBadge}</span>
        </div>
        {crisis ? (
          <SupportPanel onEdit={() => setCrisis(false)} />
        ) : (
          <>
            <label htmlFor="whisper" className="visually-hidden">{m.whispers.writeTitle}</label>
            <textarea id="whisper" className="textarea" maxLength={PRIVATE_MAX} value={text} placeholder={m.whispers.placeholder} onChange={(e) => setText(e.target.value)} />
            <div className="row-between">
              <span className="muted small">{m.whispers.privateNote}</span>
              <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={save}>{m.whispers.save}</button>
            </div>
          </>
        )}
      </section>

      {entries.length > 0 && (
        <section className="stack gap-12" aria-labelledby="entries-title">
          <h2 className="h3" id="entries-title">{m.whispers.yours}</h2>
          <ul className="stack gap-8" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {entries.map((e) => (
              <li key={e.id} className="panel-quiet stack gap-8">
                <span className="meta">{formatLocalDate(localDateKey(new Date(e.createdAt)), locale)}</span>
                <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{e.text}</p>
                <div className="btn-row" style={{ gap: 16 }}>
                  <button type="button" className="btn-link" onClick={() => talkAbout(e)}>{m.whispers.talkAbout}</button>
                  <button type="button" className="btn-link" onClick={() => window.confirm(m.whispers.confirmDelete) && deleteWhisper(e.id)}>{m.common.delete}</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel-quiet stack gap-12" aria-labelledby="wall-title">
        <div className="row-between">
          <h2 className="h3" id="wall-title">{m.whispers.wallTitle}</h2>
          <span className="badge badge-dev">{m.whispers.notLive}</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>{m.whispers.wallBody}</p>
        <ul className="small" style={{ margin: 0, paddingLeft: 20, color: "var(--text-2)" }}>
          {m.whispers.wallRules.map((r) => <li key={r}>{r}</li>)}
        </ul>
        <span className="meta">{m.whispers.decisionsTitle}</span>
        <ul className="small" style={{ margin: 0, paddingLeft: 20, color: "var(--text-2)" }}>
          {WALL_DECISIONS.map((d) => <li key={d}>{m.whispers.decisions[d]}</li>)}
        </ul>
        <p className="muted small" style={{ margin: 0 }}>{m.whispers.support} <Link href="/about">{m.nav.about}</Link></p>
      </section>
    </div>
  );
}
