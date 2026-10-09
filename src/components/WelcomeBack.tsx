"use client";
// Home greeting from real records only (lib/greeting.ts). Recorded visits stay on this device.
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { listChats, listCheckIns, listReadings, recordVisit } from "@/lib/store";
import { checkInsDue } from "@/lib/memory";
import { greetingFor, type Greeting } from "@/lib/greeting";
import { formatLocalDate, localDateKey } from "@/lib/time";

export function WelcomeBack() {
  const { m, fmt, locale } = useI18n();
  const [g, setG] = useState<Greeting | null>(null);

  useEffect(() => {
    const previous = recordVisit();
    const today = localDateKey();
    setG(greetingFor({
      previousVisitLocal: previous ? localDateKey(new Date(previous)) : null,
      todayLocal: today,
      dueCheckIns: checkInsDue(listCheckIns(), today).due,
      readings: listReadings(),
      chats: listChats(),
    }));
  }, []);

  if (!g) return null;
  const since = "days" in g && g.days ? (g.days === 1 ? m.greeting.sinceOne : fmt(m.greeting.since, { n: g.days })) : "";

  let body: ReactNode;
  let action: ReactNode = null;
  switch (g.kind) {
    case "first":
      body = m.greeting.first;
      break;
    case "checkin":
      body = <>{m.greeting.checkin} <q>{g.checkIn.action}</q>{g.more > 0 ? ` ${fmt(m.greeting.checkinMore, { n: g.more })}` : ""}</>;
      action = g.checkIn.readingId ? <Link href={`/tarot/r/${g.checkIn.readingId}`} className="btn btn-ghost">{m.greeting.openCheckin}</Link> : <Link href="/me" className="btn btn-ghost">{m.greeting.openCheckin}</Link>;
      break;
    case "reading":
      body = fmt(m.greeting.reading, { spread: m.spreads[g.reading.spread].name, date: formatLocalDate(g.reading.localDate, locale) });
      action = <Link href={`/tarot/r/${g.reading.id}`} className="btn btn-ghost">{m.greeting.openReading}</Link>;
      break;
    case "chat":
      body = <>{m.greeting.chat} <q>{g.chat.title}</q></>;
      action = <Link href={`/talk/c/${g.chat.id}`} className="btn btn-ghost">{m.greeting.openChat}</Link>;
      break;
    case "back":
      body = m.greeting.back;
      break;
  }

  return (
    <section className="panel home-greeting" aria-label={m.greeting.label}>
      <img src="/brand/moona-mark.svg" alt="" width={36} height={36} />
      <div className="stack gap-12" style={{ flex: 1, minWidth: 0 }}>
        <p className="eyebrow">{g.kind === "first" ? m.greeting.firstTitle : m.greeting.title}{since ? ` · ${since}` : ""}</p>
        <p>{body}</p>
        {g.kind !== "first" && <p className="muted small">{m.greeting.fromRecords}</p>}
        {action && <div className="btn-row">{action}</div>}
      </div>
    </section>
  );
}
