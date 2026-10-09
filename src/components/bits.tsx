"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { effectiveHelpRegion, getSettings } from "@/lib/store";
import type { HelpRegion } from "@/lib/safety";

export type Source = "offline" | "live" | "template" | "library" | "sky" | "dev";

export function SourceBadge({ source }: { source: Source }) {
  const { m } = useI18n();
  const cls = source === "live" || source === "sky" ? "badge badge-live" : source === "dev" ? "badge badge-dev" : "badge";
  return <span className={cls}>{m.badge[source]}</span>;
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

/** Honest placeholder for modules that are scheduled but not built yet. Shows no fake data. */
export function DevModule({ module, date, points }: { module: string; date: string; points: string[] }) {
  const { m, fmt } = useI18n();
  return (
    <div className="stack gap-24">
      <div className="stack gap-12">
        <SourceBadge source="dev" />
        <h1 className="h1">{fmt(m.dev.title, { module })}</h1>
        <p className="lede">{fmt(m.dev.body, { date })}</p>
      </div>
      <div className="panel">
        <p className="meta" style={{ margin: "0 0 8px" }}>{m.dev.plan}</p>
        <ul style={{ margin: 0, paddingLeft: 20, color: "var(--text-2)" }}>
          {points.map((p) => <li key={p}>{p}</li>)}
        </ul>
      </div>
    </div>
  );
}
