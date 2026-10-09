"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { effectiveHelpRegion, getSettings } from "@/lib/store";
import type { HelpRegion } from "@/lib/safety";

export type Source = "offline" | "live" | "template" | "library" | "sky" | "dev" | "calc" | "saved";

/** `time` (ISO instant) is required for "saved"; `title` shows e.g. the model on hover. */
export function SourceBadge({ source, time, title }: { source: Source; time?: string; title?: string }) {
  const { m, fmt, locale } = useI18n();
  const cls = source === "live" || source === "sky" ? "badge badge-live" : source === "dev" ? "badge badge-dev" : "badge";
  const label =
    source === "saved"
      ? fmt(m.badge.saved, { time: time ? new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(time)) : "" })
      : m.badge[source];
  return <span className={cls} title={title}>{label}</span>;
}

export function SupportPanel({ onEdit }: { onEdit?: () => void }) {
  const { m } = useI18n();
  const [region, setRegion] = useState<HelpRegion | null>(null);
  useEffect(() => setRegion(effectiveHelpRegion(getSettings())), []);

  return (
    <section className="panel support stack gap-12" role="alert" aria-live="assertive">
      <h2 className="h2">{m.support.title}</h2>
      <p className="lede" style={{ color: "var(--text-1)" }}>{m.support.body}</p>
      {region === "US" && <p style={{ margin: 0, fontWeight: 500 }}>{m.support.us}</p>}
      <p style={{ margin: 0 }}>
        {m.support.other}{" "}
        <a href="https://findahelpline.com" target="_blank" rel="noreferrer">{m.support.link}</a>
      </p>
      <p className="muted small" style={{ margin: 0 }}>{m.support.emergency}</p>
      <div className="btn-row">
        {onEdit && <button type="button" className="btn btn-ghost" onClick={onEdit}>{m.support.edit}</button>}
        <Link href="/" className="btn btn-text">{m.support.home}</Link>
      </div>
    </section>
  );
}
