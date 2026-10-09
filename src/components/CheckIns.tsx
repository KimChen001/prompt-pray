"use client";
// In-site check-ins: plan one small step and a day to look back; MOONA shows it when the person
// returns. No push or email — an optional .ics file lets their own calendar remind them.
// Functional build; visual design pending.
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { deleteCheckIn, listCheckIns, saveCheckIn, useStoreVersion } from "@/lib/store";
import { addDays, CHECKIN_ACTION_MAX, CHECKIN_OUTCOME_MAX, checkInIcs, checkInsDue, validLocalDate, type CheckIn } from "@/lib/memory";
import { formatLocalDate, localDateKey } from "@/lib/time";
import { detectCrisis } from "@/lib/safety";
import { SupportPanel } from "./bits";

function downloadIcs(c: CheckIn, title: string, description: string) {
  const url = c.readingId ? `${window.location.origin}/tarot/r/${c.readingId}` : window.location.origin;
  const blob = new Blob([checkInIcs(c, { title, description, url })], { type: "text/calendar;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = `moona-check-in-${c.dueDate}.ics`;
  a.click();
  URL.revokeObjectURL(href);
}

/** One check-in: date/status, the step, and — when due — a short "how did it go?" form. */
export function CheckInItem({ c, showReadingLink }: { c: CheckIn; showReadingLink?: boolean }) {
  const { m, fmt, locale } = useI18n();
  const [outcome, setOutcome] = useState("");
  const [crisis, setCrisis] = useState(false);
  const today = localDateKey();
  const due = c.status === "open" && c.dueDate <= today;
  const when =
    c.status === "done" ? m.checkin.statusDone :
    c.status === "dropped" ? m.checkin.statusDropped :
    c.dueDate === today ? m.checkin.dueToday :
    c.dueDate < today ? fmt(m.checkin.overdue, { date: formatLocalDate(c.dueDate, locale) }) :
    fmt(m.checkin.dueOn, { date: formatLocalDate(c.dueDate, locale) });

  function close(status: "done" | "dropped") {
    const text = outcome.trim();
    if (text && detectCrisis(text)) return setCrisis(true);
    saveCheckIn({ ...c, status, outcome: text || undefined, closedAt: new Date().toISOString() });
  }

  return (
    <li className="panel stack gap-8">
      <span className={due ? "badge badge-live" : "badge"} style={{ alignSelf: "flex-start" }}>{when}</span>
      <p style={{ margin: 0 }}>{c.action}</p>
      {c.outcome && <p className="muted small" style={{ margin: 0 }}>{c.outcome}</p>}
      {crisis && <SupportPanel onEdit={() => setCrisis(false)} />}
      {due && !crisis && (
        <div className="stack gap-8">
          <label className="meta" htmlFor={`outcome-${c.id}`}>{m.checkin.howDidItGo}</label>
          <textarea id={`outcome-${c.id}`} className="textarea" style={{ minHeight: 64 }} maxLength={CHECKIN_OUTCOME_MAX} placeholder={m.checkin.outcomePlaceholder} value={outcome} onChange={(e) => setOutcome(e.target.value)} />
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={() => close("done")}>{m.checkin.done}</button>
            <button type="button" className="btn btn-ghost" onClick={() => close("dropped")}>{m.checkin.dropped}</button>
          </div>
        </div>
      )}
      <div className="btn-row">
        {c.status !== "open" && c.readingId && <Link href={`/tarot/r/${c.readingId}?talk=1`} className="btn-text" style={{ padding: 0, minHeight: 0 }}>{m.checkin.continueReading}</Link>}
        {c.status === "open" && showReadingLink && c.readingId && <Link href={`/tarot/r/${c.readingId}`} className="btn-text" style={{ padding: 0, minHeight: 0 }}>{m.checkin.openReading}</Link>}
        {c.status === "open" && (
          <button type="button" className="btn-text" style={{ padding: 0, minHeight: 0 }} onClick={() => downloadIcs(c, fmt(m.checkin.calTitle, { action: c.action.slice(0, 60) }), `${c.action}\n\n${m.checkin.calDesc}`)}>{m.checkin.calendar}</button>
        )}
        <button type="button" className="btn-text" style={{ padding: 0, minHeight: 0 }} onClick={() => deleteCheckIn(c.id)}>{m.checkin.delete}</button>
      </div>
    </li>
  );
}

/** Plan a check-in at the end of a reading; lists this reading's check-ins. */
export function CheckInPlanner({ readingId, suggestedAction }: { readingId: string; suggestedAction: string }) {
  const { m } = useI18n();
  const version = useStoreVersion();
  const [mine, setMine] = useState<CheckIn[]>([]);
  const [action, setAction] = useState(suggestedAction.slice(0, CHECKIN_ACTION_MAX));
  const [date, setDate] = useState(() => addDays(localDateKey(), 3));
  const [crisis, setCrisis] = useState(false);

  useEffect(() => setMine(listCheckIns().filter((c) => c.readingId === readingId)), [version, readingId]);
  useEffect(() => setAction(suggestedAction.slice(0, CHECKIN_ACTION_MAX)), [suggestedAction]);

  const today = localDateKey();
  function save() {
    const text = action.trim();
    if (!text || !validLocalDate(date) || date < today) return;
    if (detectCrisis(text)) return setCrisis(true);
    saveCheckIn({ id: crypto.randomUUID(), readingId, action: text, dueDate: date, createdAt: new Date().toISOString(), status: "open" });
  }

  return (
    <section className="stack gap-12" aria-labelledby="checkin-title">
      <h2 className="h3" id="checkin-title">{m.checkin.title}</h2>
      {mine.length > 0 && <ul className="stack gap-8" style={{ listStyle: "none", padding: 0, margin: 0 }}>{mine.map((c) => <CheckInItem key={c.id} c={c} />)}</ul>}
      {crisis ? (
        <SupportPanel onEdit={() => setCrisis(false)} />
      ) : (
        <div className="stack gap-8">
          <p className="muted small" style={{ margin: 0 }}>{m.checkin.intro}</p>
          <label className="meta" htmlFor="checkin-action">{m.checkin.action}</label>
          <textarea id="checkin-action" className="textarea" style={{ minHeight: 64 }} maxLength={CHECKIN_ACTION_MAX} value={action} onChange={(e) => setAction(e.target.value)} />
          <span className="meta">{m.checkin.when}</span>
          <div className="btn-row" role="group" aria-label={m.checkin.when}>
            {([3, 7, 14] as const).map((d) => {
              const value = addDays(today, d);
              return <button key={d} type="button" className="chip" aria-pressed={date === value} onClick={() => setDate(value)}>{m.checkin[`in${d}`]}</button>;
            })}
            <label className="visually-hidden" htmlFor="checkin-date">{m.checkin.date}</label>
            <input id="checkin-date" type="date" className="input" style={{ width: "auto" }} min={today} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div><button type="button" className="btn btn-ghost" onClick={save} disabled={!action.trim() || !validLocalDate(date) || date < today}>{m.checkin.save}</button></div>
        </div>
      )}
    </section>
  );
}

/** Home: check-ins that are due, shown when the person comes back. Renders nothing if there are none. */
export function CheckInsDue() {
  const { m, fmt } = useI18n();
  const version = useStoreVersion();
  const [state, setState] = useState<{ due: CheckIn[]; upcoming: number; recent: CheckIn[] } | null>(null);

  useEffect(() => {
    const all = listCheckIns();
    const { due, upcoming } = checkInsDue(all, localDateKey());
    // Keep a just-closed check-in visible for this visit so "Continue the reading" stays reachable.
    setState((prev) => ({ due, upcoming, recent: prev ? all.filter((c) => c.status !== "open" && prev.due.some((p) => p.id === c.id)) : [] }));
  }, [version]);

  if (!state || (state.due.length === 0 && state.recent.length === 0)) return null;
  return (
    <section className="stack gap-12" aria-labelledby="due-title">
      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <h2 className="h2" id="due-title">{m.checkin.homeTitle}</h2>
        {state.upcoming > 0 && <Link href="/me" className="muted small">{fmt(m.checkin.upcoming, { n: state.upcoming })}</Link>}
      </div>
      <ul className="stack gap-8" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {[...state.due, ...state.recent].map((c) => <CheckInItem key={c.id} c={c} showReadingLink />)}
      </ul>
    </section>
  );
}
