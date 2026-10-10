"use client";
// Natal report: 3–5 rule-selected themes. Library text is always available offline; an AI version is
// generated once per chart + rules + language and saved on this device. When the rules or prompt
// change, the saved version stays and a new one is written only when the user asks.
// `useNatalReport` holds the state so the "Chart synthesis" card (Figma: Interpretation / Chart
// synthesis) and the full report below it show the same version.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { dataEpoch, deleteNatalReport, listNatalReports, saveNatalReport, useStoreVersion } from "@/lib/store";
import type { BirthData } from "@/lib/astro/birth";
import type { NatalChart } from "@/lib/astro/chart";
import type { HouseSystem } from "@/lib/astro/houses";
import { natalFacts, type NatalFacts } from "@/lib/astro/natal-facts";
import { selectThemes } from "@/lib/astro/natal-themes";
import { factLabel, themeLibraryText } from "@/lib/astro/natal-text";
import {
  keyString, natalRequestBody, natalVersionKey, sameChart, toSavedReport,
  type NatalAiResponse, type SavedNatalReport, type SavedNatalTheme,
} from "@/lib/astro/natal-report";
import { NATAL_PROMPT_VERSION } from "@/lib/ai/natal-prompt";
import { SourceBadge, aiSource } from "./bits";
import { newRequestId, requestAiOnce, type OfflineReason } from "@/lib/ai/client";

type GenStatus = "idle" | "loading" | "live" | "failed" | "off";
const LIBRARY = "library";

export function useNatalReport(birth: BirthData, chart: NatalChart, houseSystem: HouseSystem) {
  const { m, pick, locale } = useI18n();
  const storeVersion = useStoreVersion();
  const [gen, setGen] = useState<GenStatus>("idle");
  const [notice, setNotice] = useState<string | null>(null); // why live AI is off (quota, budget, paused)
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
  const latestId = useRef(currentId);
  latestId.current = currentId;

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
    const requestedFor = currentId;
    const epoch = dataEpoch();
    setGen("loading");
    setNotice(null);
    try {
      // one id per attempt: a retry inside it (still running, busy) replays rather than pays twice
      const out = await requestAiOnce<NatalAiResponse>("/api/ai/natal", natalRequestBody(nf, sel, locale) as unknown as Record<string, unknown>, { requestId: newRequestId() });
      // Birth details were removed or changed while this was being written: it belongs to nobody now.
      if (epoch !== dataEpoch()) return;
      const stillHere = latestId.current === requestedFor; // the person may have switched language or house system
      const why = (r: OfflineReason | "quota") => (r === "quota" ? m.aiNotice.quotaShort : r === "budget" ? m.aiNotice.budgetShort : r === "ledger" || r === "paused" ? m.aiNotice.pausedShort : r === "busy" ? m.aiNotice.busyShort : null);
      if (out.state === "quota" || out.state === "offline") {
        if (!stillHere) return;
        setNotice(why(out.state === "quota" ? "quota" : out.reason));
        return setGen(out.state === "offline" && (out.reason === "network" || out.reason === "busy") ? "failed" : "off"); // off: library text
      }
      if (out.state !== "done") return stillHere && setGen("failed");
      const body = out.value;
      // A valid result for its own key (chart + rules + language) is kept even if the view moved on.
      const report = toSavedReport({ ...key, promptVersion: body.promptVersion }, nf, sel, body);
      if (!saveNatalReport(report)) setMemory(report);
      if (!stillHere) return;
      setLiveAt(report.createdAt);
      setSelected(null);
      setGen("live");
    } catch {
      if (latestId.current === requestedFor) setGen("failed");
    }
  }, [currentId, nf, sel, locale, key, m]);

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
  const removeVersion = (r: SavedNatalReport) => {
    // The deleted version must not be regenerated behind the user's back.
    attempted.current.add(keyString(r.key));
    if (selected === r.createdAt) setSelected(null);
    if (memory?.createdAt === r.createdAt) setMemory(null);
    deleteNatalReport(r.createdAt);
  };

  return { nf, gen, notice, liveAt, saved, exact, older, chosen, report, themes: report ? report.themes : library, selected, setSelected, generate, removeVersion, key, currentId };
}

export type NatalState = ReturnType<typeof useNatalReport>;

/** Facts for the wheel's aspect lines, from the same fact layer the report cites. */
export function wheelAspects(nf: NatalFacts) {
  return nf.facts.flatMap((f) => (f.kind === "aspect" ? [{ a: f.a, b: f.b, aspect: f.aspect }] : []));
}

/** Figma "Interpretation / Chart synthesis" card: the report's overview, linked to the full reading. */
export function SynthesisCard({ natal }: { natal: NatalState }) {
  const { m } = useI18n();
  const { report, gen, liveAt } = natal;
  return (
    <article className="interp-card">
      {report ? (
        <SourceBadge source={aiSource(report.meta, report.createdAt === liveAt)} time={report.createdAt} title={report.meta.model} />
      ) : (
        <SourceBadge source="library" />
      )}
      <h3>{m.chartPage.synthesis}</h3>
      <p>{gen === "loading" && !report ? m.natal.loadingAi : report ? report.overview : m.chartPage.synthesisLibrary}</p>
      <Link href="#natal-title" className="more">{m.chartPage.readFull} ↓</Link>
    </article>
  );
}

export function NatalReport({ natal }: { natal: NatalState }) {
  const { m, fmt, pick, locale } = useI18n();
  const { gen, notice, liveAt, saved, exact, older, chosen, report, themes, selected, setSelected, generate, removeVersion, key, currentId } = natal;
  const describe = (r: SavedNatalReport) =>
    keyString(r.key) === currentId ? m.natal.thisChart : sameChart(r.key, key) ? m.natal.earlierRules : m.natal.earlierChart;
  const fmtTime = (iso: string) =>
    new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

  return (
    <section className="stack gap-4" aria-labelledby="natal-title" aria-busy={gen === "loading"}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h2 className="h2" id="natal-title" style={{ scrollMarginTop: 100 }}>{m.natal.title}</h2>
        {report ? (
          <SourceBadge source={aiSource(report.meta, report.createdAt === liveAt)} time={report.createdAt} title={report.meta.model} />
        ) : (
          <SourceBadge source="library" />
        )}
      </div>
      <p className="muted small" style={{ margin: 0 }}>{m.natal.intro}</p>

      {gen === "loading" && <p className="muted small" style={{ margin: 0 }}>{m.natal.loadingAi}</p>}
      {(gen === "off" || gen === "failed") && notice && <p className="muted small" style={{ margin: 0 }}>{notice}</p>}
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
        <div className="panel stack gap-2">
          <span className="meta">{m.natal.overview}</span>
          <p style={{ margin: 0 }}>{report.overview}</p>
        </div>
      )}

      <div className="interp-grid">
        {themes.map((t) => (
          <article key={t.id} className="interp-card">
            <h3 style={{ fontSize: 26 }}>{pick(t.title)}</h3>
            <p style={{ color: "var(--text-1)" }}>{t.text}</p>
            <details style={{ marginTop: "auto" }}>
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
      </div>

      <p className="muted small" style={{ margin: 0 }}>{report ? m.natal.aiNote : m.natal.libraryNote} {m.natal.sentNote}</p>

      <details>
        <summary className="meta" style={{ cursor: "pointer" }}>{fmt(m.natal.versions, { n: saved.length })}</summary>
        <ul className="stack gap-2" style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
          <li style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span className="small">{m.natal.libraryOption}</span>
            <button type="button" className="btn-text" style={{ minHeight: 0, padding: 0 }} aria-pressed={selected === LIBRARY} onClick={() => setSelected(LIBRARY)}>{m.natal.view}</button>
          </li>
          {saved.map((r) => (
            <li key={r.createdAt} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span className="small">{fmtTime(r.createdAt)} · {describe(r)}</span>
              <span className="muted small">{r.meta.model} · {r.key.promptVersion}</span>
              <button type="button" className="btn-text" style={{ minHeight: 0, padding: 0 }} aria-pressed={report?.createdAt === r.createdAt} onClick={() => setSelected(r.createdAt)}>{m.natal.view}</button>
              <button type="button" className="btn-text" style={{ minHeight: 0, padding: 0 }} onClick={() => removeVersion(r)}>{m.natal.delete}</button>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
