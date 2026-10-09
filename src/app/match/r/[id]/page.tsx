"use client";
// Match result: three dimensions (Emotional · Communication · Attraction), each with its label and
// the factors behind it, plus the big picture and a for-fun score. Shown from the saved snapshot so
// it never changes on reload. Functional build; visual design pending.
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useRouteSegment } from "@/lib/shell";
import { deleteMatch, getMatch, type SavedMatch } from "@/lib/store";
import type { Dimension } from "@/lib/astro/match";
import { formatLocalDate, localDateKey } from "@/lib/time";
import { SourceBadge } from "@/components/bits";
import { FactorLine } from "@/components/MatchParts";
import { ShareImage } from "@/components/ShareImage";
import { matchCard } from "@/lib/share/content";

export default function MatchResultPage() {
  return (
    <Suspense fallback={null}>
      <MatchResult />
    </Suspense>
  );
}

const DIMS: Exclude<Dimension, "core">[] = ["emotional", "communication", "attraction"];

function MatchResult() {
  const id = useRouteSegment(useParams<{ id: string }>().id, 2); // null until known on the offline shell
  const params = useSearchParams();
  const router = useRouter();
  const { m, fmt, locale } = useI18n();
  const [match, setMatch] = useState<SavedMatch | null | undefined>(undefined);
  useEffect(() => {
    if (id !== null) setMatch(getMatch(id));
  }, [id]);

  if (match === undefined) return null;
  if (!match) {
    return (
      <div className="stack gap-16">
        <h1 className="h1">{m.match.notFound}</h1>
        <div><Link href="/match" className="btn btn-ghost">{m.match.all}</Link></div>
      </div>
    );
  }

  const r = match.result;
  const name = match.b.name || m.match.defaultName;
  const factors = (d: Dimension) => r.factors.filter((f) => f.dimension === d);

  return (
    <div className="stack gap-24" style={{ maxWidth: 760 }}>
      <header className="stack gap-8">
        <Link href="/match" className="meta">← {m.match.all}</Link>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h1 className="h1">{fmt(m.match.resultTitle, { name })}</h1>
          <SourceBadge source="calc" />
        </div>
        <span className="muted small">{fmt(m.match.computed, { version: r.version, date: formatLocalDate(localDateKey(new Date(match.createdAt)), locale) })}</span>
        {params.get("local") === "0" && <p className="notice">{m.common.storageOff}</p>}
      </header>

      <section className="panel stack gap-8" aria-labelledby="vibe">
        <span className="meta" id="vibe">{m.match.score}</span>
        {r.score !== null ? <span className="display" style={{ lineHeight: 1 }}>{r.score}</span> : <p style={{ margin: 0 }}>{m.match.scoreNone}</p>}
        <p className="muted small" style={{ margin: 0 }}>{m.match.disclaimer}</p>
        <details>
          <summary className="meta" style={{ cursor: "pointer" }}>{m.match.howScore}</summary>
          <p className="muted small" style={{ margin: "8px 0 0" }}>{m.match.scoreHow}</p>
        </details>
      </section>

      <div className="grid-tiles">
        {DIMS.map((d) => {
          const label = r.labels[d];
          return (
            <section key={d} className="panel stack gap-8" aria-labelledby={`dim-${d}`}>
              <span className="meta">{m.match.dimBasis[d]}</span>
              <h2 className="h3" id={`dim-${d}`} style={{ margin: 0 }}>{m.match.dims[d]}</h2>
              <span className={label === "unknown" ? "badge" : "badge badge-live"} style={{ alignSelf: "flex-start" }}>{m.match.labels[label]}</span>
              <p style={{ margin: 0 }}>{label === "unknown" ? m.match.text.unknown : m.match.text[d][label]}</p>
              <details>
                <summary className="meta" style={{ cursor: "pointer" }}>{m.match.why}</summary>
                <ul style={{ margin: "8px 0 0", paddingLeft: 20, color: "var(--text-2)" }}>
                  {factors(d).map((f, i) => <FactorLine key={i} f={f} name={name} />)}
                </ul>
              </details>
            </section>
          );
        })}
      </div>

      <section className="stack gap-8" aria-labelledby="dim-core">
        <h2 className="h3" id="dim-core">{m.match.dims.core}</h2>
        <ul style={{ margin: 0, paddingLeft: 20, color: "var(--text-2)" }}>
          {factors("core").map((f, i) => <FactorLine key={i} f={f} name={name} />)}
        </ul>
        {r.notes.some((n) => n.startsWith("rising")) && <p className="muted small" style={{ margin: 0 }}>{m.match.noteRising}</p>}
        {r.notes.some((n) => n.startsWith("window")) && <p className="muted small" style={{ margin: 0 }}>{m.match.noteWindow}</p>}
      </section>

      <div className="btn-row">
        <ShareImage
          filename="moona-match.png"
          options={match.b.name ? [{ key: "name", label: m.share.includeName }] : []}
          build={(o) => matchCard(match, m, { includeName: !!o.name })}
        />
        <Link href="/match" className="btn btn-ghost">{m.match.newMatch}</Link>
        <button
          type="button"
          className="btn-text"
          onClick={() => {
            if (!window.confirm(m.match.confirmDelete)) return;
            deleteMatch(match.id);
            router.push("/match");
          }}
        >
          {m.match.delete}
        </button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>{m.match.consent}</p>
    </div>
  );
}
