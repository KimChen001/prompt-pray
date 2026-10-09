"use client";
// Natal report: 3–5 rule-selected themes. Library text is always available offline; an AI version is
// generated once per chart + rules + language and saved on this device. When the rules or prompt
// change, the saved version stays and a new one is written only when the user asks.
// Functional build; visual design pending.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { deleteNatalReport, listNatalReports, saveNatalReport, useStoreVersion } from "@/lib/store";
import type { BirthData } from "@/lib/astro/birth";
import type { NatalChart } from "@/lib/astro/chart";
import type { HouseSystem } from "@/lib/astro/houses";
import { natalFacts } from "@/lib/astro/natal-facts";
import { selectThemes } from "@/lib/astro/natal-themes";
import { factLabel, themeLibraryText } from "@/lib/astro/natal-text";
import {
  keyString, natalRequestBody, natalVersionKey, sameChart, toSavedReport,
  type NatalAiResponse, type SavedNatalReport, type SavedNatalTheme,
} from "@/lib/astro/natal-report";
import { NATAL_PROMPT_VERSION } from "@/lib/ai/natal-prompt";
import { SourceBadge } from "./bits";

type GenStatus = "idle" | "loading" | "live" | "failed" | "off";
const LIBRARY = "library";

export function NatalReport({ birth, chart, houseSystem }: { birth: BirthData; chart: NatalChart; houseSystem: HouseSystem }) {
  const { m, fmt, pick, locale } = useI18n();
  const storeVersion = useStoreVersion();
  const [gen, setGen] = useState<GenStatus>("idle");
  const [liveAt, setLiveAt] = useState<string | null>(null); // createdAt of the version generated in this view
  const [memory, setMemory] = useState<SavedNatalReport | null>(null); // when storage is blocked
  const [selected, setSelected] = useState<string | null>(null); // a createdAt, LIBRARY, or null = default
  const attempted = useRef(new Set<string>());

  const { nf, sel } = useMemo(() => {
    const nf = natalFacts(birth, chart);
    return { nf, sel: selectThemes(nf) };
  }, [birth, chart]);
  const key = useMemo(() => natalVersionKey(nf, sel, houseSystem, NATAL_PROMPT_VERSION, locale), [nf, sel, houseSystem, locale]);
  const currentId = keyString(key);

  const saved = useMemo(() => {
    const list = listNatalReports();
    if (memory && !list.some((r) => r.createdAt === memory.createdAt)) list.unshift(memory);
    return list.filter((r) => r.key.locale === locale);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when local data changes
  }, [storeVersion, memory, locale]);
  const exact = saved.find((r) => keyString(r.key) === currentId) ?? null;
  const older = exact ? null : saved.find((r) => sameChart(r.key, key)) ?? null;

  const generate = useCallback(async () => {
    attempted.current.add(currentId);
    setGen("loading");
    try {
      const res = await fetch("/api/ai/natal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(natalRequestBody(nf, sel, locale)),
      });
      if (res.status === 503) return setGen("off"); // not configured / locked: library text, no warning
      if (!res.ok) return setGen("failed");
      const body = (await res.json()) as NatalAiResponse;
      const report = toSavedReport({ ...key, promptVersion: body.promptVersion }, nf, sel, body);
      if (!saveNatalReport(report)) setMemory(report);
      setLiveAt(report.createdAt);
      setSelected(null);
      setGen("live");
    } catch {
      setGen("failed");
    }
  }, [currentId, nf, sel, locale, key]);

  // Write the first version for a chart automatically; never silently replace an existing one.
  useEffect(() => {
    if (exact || older || attempted.current.has(currentId)) return;
    void generate();
  }, [exact, older, currentId, generate]);

  const library = useMemo<SavedNatalTheme[]>(
    () => sel.themes.map((t) => ({
      id: t.id,
      title: t.title,
      text: pick(themeLibraryText(t, nf.byId)),
      evidence: t.evidenceIds.map((id) => ({ id, label: factLabel(nf.byId.get(id)!) })),
      limitations: t.limitations,
    })),
    [sel, nf, pick],
  );

  const chosen = selected && selected !== LIBRARY ? saved.find((r) => r.createdAt === selected) ?? null : null;
  const report = selected === LIBRARY ? null : chosen ?? exact ?? older;
  const themes = report ? report.themes : library;
  const describe = (r: SavedNatalReport) =>
    keyString(r.key) === currentId ? m.natal.thisChart : sameChart(r.key, key) ? m.natal.earlierRules : m.natal.earlierChart;
  const fmtTime = (iso: string) =>
    new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

  return (
    <section className="stack gap-16" aria-labelledby="natal-title" aria-busy={gen === "loading"}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h2 className="h2" id="natal-title">{m.natal.title}</h2>
        {report ? (
          <SourceBadge source={report.createdAt === liveAt ? "live" : "saved"} time={report.createdAt} title={report.meta.model} />
        ) : (
          <SourceBadge source="library" />
        )}
      </div>
      <p className="muted small" style={{ margin: 0 }}>{m.natal.intro}</p>

      {gen === "loading" && <p className="muted small" style={{ margin: 0 }}>{m.natal.loadingAi}</p>}
      {gen === "failed" && !report && (
        <p className="notice" style={{ margin: 0 }}>
          {m.natal.aiFallback}{" "}
          <button type="button" className="btn-text" style={{ minHeight: 0, padding: 0 }} onClick={() => void generate()}>{m.natal.retry}</button>
        </p>
      )}
      {!exact && !older && gen === "idle" && (
        <div><button type="button" className="btn btn-ghost" onClick={() => void generate()}>{m.natal.generate}</button></div>
      )}
      {!selected && older && !exact && gen !== "loading" && (
        <p className="notice" style={{ margin: 0 }}>
          {m.natal.newVersion}{" "}
          <button type="button" className="btn-text" style={{ minHeight: 0, padding: 0 }} onClick={() => void generate()}>{m.natal.generateNew}</button>
          {gen === "off" && <> {m.natal.aiOff}</>}
          {gen === "failed" && <> {m.natal.aiFailed}</>}
        </p>
      )}
      {chosen && (
        <p className="notice" style={{ margin: 0 }}>
          {fmt(m.natal.viewing, { time: fmtTime(chosen.createdAt), what: describe(chosen) })}{" "}
          <button type="button" className="btn-text" style={{ minHeight: 0, padding: 0 }} onClick={() => setSelected(null)}>{m.natal.backToCurrent}</button>
        </p>
      )}

      {selected === LIBRARY && (exact || older) && (
        <p className="notice" style={{ margin: 0 }}>
          {m.natal.viewingLibrary}{" "}
          <button type="button" className="btn-text" style={{ minHeight: 0, padding: 0 }} onClick={() => setSelected(null)}>{m.natal.backToCurrent}</button>
        </p>
      )}

      {report && (
        <div className="panel stack gap-8">
          <span className="meta">{m.natal.overview}</span>
          <p style={{ margin: 0 }}>{report.overview}</p>
        </div>
      )}

      {themes.map((t) => (
        <article key={t.id} className="panel stack gap-8">
          <h3 className="h3" style={{ margin: 0 }}>{pick(t.title)}</h3>
          <p style={{ margin: 0 }}>{t.text}</p>
          <details>
            <summary className="meta" style={{ cursor: "pointer" }}>{m.natal.why}</summary>
            <ul style={{ margin: "8px 0 0", paddingLeft: 20, color: "var(--text-2)" }}>
              {t.evidence.map((e) => <li key={e.id} className="small">{pick(e.label)}</li>)}
            </ul>
            {t.limitations.length > 0 && (
              <p className="muted small" style={{ margin: "8px 0 0" }}>{m.natal.limits} {t.limitations.map((l) => pick(l)).join(" ")}</p>
            )}
          </details>
        </article>
      ))}

      <p className="muted small" style={{ margin: 0 }}>{report ? m.natal.aiNote : m.natal.libraryNote} {m.natal.sentNote}</p>

      <details>
        <summary className="meta" style={{ cursor: "pointer" }}>{fmt(m.natal.versions, { n: saved.length })}</summary>
        <ul className="stack gap-8" style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
          <li style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span className="small">{m.natal.libraryOption}</span>
            <button type="button" className="btn-text" style={{ minHeight: 0, padding: 0 }} aria-pressed={selected === LIBRARY} onClick={() => setSelected(LIBRARY)}>{m.natal.view}</button>
          </li>
          {saved.map((r) => (
            <li key={r.createdAt} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span className="small">{fmtTime(r.createdAt)} · {describe(r)}</span>
              <span className="muted small">{r.meta.model} · {r.key.promptVersion}</span>
              <button type="button" className="btn-text" style={{ minHeight: 0, padding: 0 }} aria-pressed={report?.createdAt === r.createdAt} onClick={() => setSelected(r.createdAt)}>{m.natal.view}</button>
              <button
                type="button"
                className="btn-text"
                style={{ minHeight: 0, padding: 0 }}
                onClick={() => {
                  // The deleted version must not be regenerated behind the user's back.
                  attempted.current.add(keyString(r.key));
                  if (selected === r.createdAt) setSelected(null);
                  if (memory?.createdAt === r.createdAt) setMemory(null);
                  deleteNatalReport(r.createdAt);
                }}
              >
                {m.natal.delete}
              </button>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
