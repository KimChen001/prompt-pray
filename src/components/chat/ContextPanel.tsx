"use client";
// "What MOONA can see in this conversation": the person ticks exactly what is sent with their
// messages. Three kinds, labelled the same everywhere: what they said (saved notes), what was
// calculated (chart, today's sky), and MOONA's own reflection (the replies, symbolic).
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { getSettings } from "@/lib/store";
import { computeChart, type SignCandidate } from "@/lib/astro/chart";
import { skyForDay } from "@/lib/astro/sky";
import { SIGN_INFO } from "@/lib/astro/zodiac";
import type { BirthData } from "@/lib/astro/birth";
import type { MemoryNote } from "@/lib/memory";
import { MAX_NOTES_SENT } from "@/lib/memory";
import type { ChatContextChoice } from "@/lib/chat/session";
import { localDateKey, userTimeZone } from "@/lib/time";

export function ContextPanel({ choice, onChange, birth, notes, idPrefix = "ctx", startOpen = false }: { choice: ChatContextChoice; onChange: (c: ChatContextChoice) => void; birth: BirthData | null; notes: MemoryNote[]; idPrefix?: string; startOpen?: boolean }) {
  const { m, fmt, pick } = useI18n();
  const [open, setOpen] = useState(startOpen);

  const chartLine = useMemo(() => {
    if (!birth) return null;
    try {
      const { sun, moon, rising } = computeChart(birth, getSettings().houseSystem).bigThree;
      const show = (c: SignCandidate | null) =>
        !c ? m.talk.risingUnknown : c.placement ? pick(SIGN_INFO[c.placement.sign].name) : fmt(m.chart.or, { a: pick(SIGN_INFO[c.options![0]].name), b: pick(SIGN_INFO[c.options![1]].name) });
      return `${m.chart.sun} ${show(sun)} · ${m.chart.moon} ${show(moon)} · ${m.chart.rising} ${show(rising)}`;
    } catch {
      return null;
    }
  }, [birth, m, fmt, pick]);

  // The local day and zone exist only in the browser: computed after mount, never during server render.
  const [skyLine, setSkyLine] = useState("");
  useEffect(() => {
    try {
      const sky = skyForDay(localDateKey(), userTimeZone());
      setSkyLine(`${fmt(m.sky.moonIn, { sign: pick(SIGN_INFO[sky.moon.placement.sign].name) })} · ${m.sky.phases[sky.moon.phase]} · ${fmt(m.sky.sunIn, { sign: pick(SIGN_INFO[sky.sun.sign].name) })}`);
    } catch {
      setSkyLine("");
    }
  }, [m, fmt, pick]);

  const usable = notes.filter((n) => !n.paused);
  const paused = notes.length - usable.length;
  const chosen = choice.noteIds.filter((id) => usable.some((n) => n.id === id));
  const count = (choice.chart && birth ? 1 : 0) + (choice.today ? 1 : 0) + chosen.length;

  const toggleNote = (id: string, on: boolean) => {
    const ids = on ? [...chosen, id].slice(0, MAX_NOTES_SENT) : chosen.filter((x) => x !== id);
    onChange({ ...choice, noteIds: ids });
  };

  return (
    <details className="panel context-panel" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="row-between" style={{ listStyle: "none", cursor: "pointer" }}>
        <span className="stack gap-1">
          <span className="eyebrow">{m.talk.contextTitle}</span>
          <span className="small">{count === 1 ? m.talk.contextCountOne : count ? fmt(m.talk.contextCount, { n: count }) : m.talk.contextNone}</span>
        </span>
        <span className="disclosure-summary" aria-hidden="true" />
      </summary>

      <div className="stack gap-4" style={{ marginTop: 14 }}>
        <div className="stack gap-2">
          <span className="meta">{m.talk.kindCalc}</span>
          <ul className="context-list">
            <li className="context-item">
              <input type="checkbox" id={`${idPrefix}-chart`} checked={choice.chart && !!birth} disabled={!birth} onChange={(e) => onChange({ ...choice, chart: e.target.checked })} />
              <label htmlFor={`${idPrefix}-chart`} className="stack gap-1">
                <span>{m.talk.ctxChart}</span>
                {birth ? <span className="muted">{chartLine}</span> : <span className="muted">{m.talk.ctxChartNone} <Link href="/chart/edit">{m.chart.add}</Link></span>}
              </label>
            </li>
            <li className="context-item">
              <input type="checkbox" id={`${idPrefix}-today`} checked={choice.today} onChange={(e) => onChange({ ...choice, today: e.target.checked })} />
              <label htmlFor={`${idPrefix}-today`} className="stack gap-1">
                <span>{m.talk.ctxToday}</span>
                <span className="muted">{skyLine}</span>
              </label>
            </li>
          </ul>
        </div>

        <div className="stack gap-2">
          <span className="meta">{m.talk.kindSaid}</span>
          {usable.length ? (
            <ul className="context-list">
              {usable.map((n) => (
                <li key={n.id} className="context-item">
                  <input type="checkbox" id={`${idPrefix}-note-${n.id}`} checked={chosen.includes(n.id)} onChange={(e) => toggleNote(n.id, e.target.checked)} />
                  <label htmlFor={`${idPrefix}-note-${n.id}`}>{n.text}</label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>{m.talk.ctxNoNotes}</p>
          )}
          {paused > 0 && <p className="muted small" style={{ margin: 0 }}>{fmt(m.talk.ctxPaused, { n: paused })}</p>}
          <Link href="/me#notes-title" className="small">{m.talk.manageNotes}</Link>
        </div>

        <div className="stack gap-2">
          <span className="meta">{m.talk.kindReflection}</span>
          <p className="muted small" style={{ margin: 0 }}>{m.talk.reflectionNote}</p>
        </div>

        <p className="muted small" style={{ margin: 0 }}>{m.talk.contextPrivacy}</p>
      </div>
    </details>
  );
}
