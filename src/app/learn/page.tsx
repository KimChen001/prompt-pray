"use client";
// Learn home (plan v0.2 §3.6): search in English and Chinese at once, filter by type, or browse.
// Functional build; visual design pending.
import Link from "next/link";
import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { allEntries, learnHref, LEARN_TYPES, searchLearn, type LearnEntry, type LearnType } from "@/lib/learn";

const SUGGESTIONS: { en: string; zh: string }[] = [
  { en: "Moon", zh: "月亮" },
  { en: "Scorpio", zh: "天蝎" },
  { en: "Rising", zh: "上升" },
  { en: "Tower", zh: "高塔" },
  { en: "trine", zh: "三分相" },
];

function EntryLink({ e }: { e: LearnEntry }) {
  const { pick } = useI18n();
  return (
    <Link href={learnHref(e.type, e.slug)} className="tile" style={{ minHeight: 0, padding: "12px 14px" }}>
      <span style={{ fontWeight: 500 }}>{e.glyph ? <span aria-hidden="true">{e.glyph}&#xFE0E; </span> : null}{pick(e.title)}</span>
      <span className="muted small">{pick(e.subtitle)}</span>
    </Link>
  );
}

export default function LearnPage() {
  const { m, fmt, pick, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<LearnType | null>(null);

  const results = useMemo(() => (query.trim() ? searchLearn(query, type ?? undefined) : null), [query, type]);
  const browse = useMemo(() => {
    const all = allEntries();
    return (type ? [type] : LEARN_TYPES).map((t) => ({ t, entries: all.filter((e) => e.type === t) }));
  }, [type]);

  return (
    <div className="stack gap-32">
      <header className="stack gap-12">
        <h1 className="h1">{m.learn.title}</h1>
        <p className="lede">{m.learn.subtitle}</p>
        <label htmlFor="learn-q" className="visually-hidden">{m.learn.searchLabel}</label>
        <input id="learn-q" type="search" className="input" placeholder={m.learn.searchPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
        <div className="btn-row" role="group" aria-label={m.learn.searchLabel}>
          <button type="button" className="chip" aria-pressed={type === null} onClick={() => setType(null)}>{m.learn.all}</button>
          {LEARN_TYPES.map((t) => (
            <button key={t} type="button" className="chip" aria-pressed={type === t} onClick={() => setType(t)}>{m.learn.types[t]}</button>
          ))}
        </div>
      </header>

      {results ? (
        <section className="stack gap-12" aria-live="polite">
          {results.length ? (
            <>
              <span className="meta">{fmt(m.learn.results, { n: results.length })}</span>
              <div className="grid-tiles">{results.slice(0, 60).map((e) => <EntryLink key={`${e.type}/${e.slug}`} e={e} />)}</div>
            </>
          ) : (
            <div className="stack gap-8">
              <p style={{ margin: 0 }}>{fmt(m.learn.noResults, { q: query.trim() })}</p>
              <div className="btn-row">
                <span className="muted small">{m.learn.tryThese}</span>
                {SUGGESTIONS.map((s) => <button key={s.en} type="button" className="chip" onClick={() => setQuery(s[locale])}>{s[locale]}</button>)}
              </div>
            </div>
          )}
        </section>
      ) : (
        browse.map(({ t, entries }) => (
          <section key={t} className="stack gap-12" aria-labelledby={`learn-${t}`}>
            <h2 className="h2" id={`learn-${t}`}>{m.learn.types[t]}</h2>
            {t === "card" ? (
              <div className="stack gap-12">
                {(["major", "wands", "cups", "swords", "pentacles"] as const).map((g) => {
                  const group = entries.filter((e) => (g === "major" ? e.slug.startsWith("major-") : e.slug.startsWith(`${g}-`)));
                  return (
                    <div key={g} className="stack gap-4">
                      <span className="meta">{pick(group[0].subtitle).split(" · ")[0]}</span>
                      <p className="small" style={{ margin: 0, lineHeight: 1.9 }}>
                        {group.map((e, i) => (
                          <span key={e.slug}>
                            {i > 0 && <span aria-hidden="true"> · </span>}
                            <Link href={learnHref("card", e.slug)}>{pick(e.title)}</Link>
                          </span>
                        ))}
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="grid-tiles">{entries.map((e) => <EntryLink key={e.slug} e={e} />)}</div>
            )}
          </section>
        ))
      )}
    </div>
  );
}
