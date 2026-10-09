"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import {
  clearBirth, clearLocalData, deleteReading, listCheckIns, listFavorites, toggleFavorite, type Favorite, exportLocalData, getBirth, getSettings, listReadings, storageAvailable, updateSettings, useStoreVersion, type Settings,
} from "@/lib/store";
import { computeChart } from "@/lib/astro/chart";
import { SIGN_INFO } from "@/lib/astro/zodiac";
import type { BirthData } from "@/lib/astro/birth";
import { guessHelpRegion } from "@/lib/safety";
import { userTimeZone } from "@/lib/time";
import type { Reading } from "@/lib/tarot/types";
import { ReadingList } from "@/components/ReadingList";
import { NotesManager } from "@/components/Notes";
import { CheckInItem } from "@/components/CheckIns";
import type { CheckIn } from "@/lib/memory";
import { getEntry, learnHref, type LearnType } from "@/lib/learn";

export default function MePage() {
  const { m, fmt, pick, locale, setLocale } = useI18n();
  const version = useStoreVersion();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [checkIns, setCheckIns] = useState<CheckIn[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [storageOk, setStorageOk] = useState(true);
  const [guess, setGuess] = useState<"US" | "other">("other");
  const [birth, setBirth] = useState<BirthData | null>(null);
  const [aiCode, setAiCode] = useState("");
  const [aiSaved, setAiSaved] = useState(false);

  useEffect(() => {
    setSettings(getSettings());
    setReadings(listReadings());
    setCheckIns(listCheckIns());
    setFavorites(listFavorites());
    setStorageOk(storageAvailable());
    setGuess(guessHelpRegion(userTimeZone()));
    setBirth(getBirth());
  }, [version]);

  const bigThree = useMemo(() => {
    if (!birth) return null;
    try {
      const { sun, moon, rising } = computeChart(birth).bigThree;
      const show = (c: typeof sun | null) =>
        !c ? "?" : c.placement ? pick(SIGN_INFO[c.placement.sign].name) : c.options ? fmt(m.chart.or, { a: pick(SIGN_INFO[c.options[0]].name), b: pick(SIGN_INFO[c.options[1]].name) }) : "?";
      return `${m.chart.sun} ${show(sun)} · ${m.chart.moon} ${show(moon)} · ${m.chart.rising} ${show(rising)}`;
    } catch {
      return null;
    }
  }, [birth, pick, fmt, m]);

  if (!settings) return null;

  function download() {
    const blob = new Blob([exportLocalData()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "moona-data.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  const regionName = (r: "US" | "other") => (r === "US" ? m.me.regionUS : m.me.regionOther);

  function saveAiCode() {
    // Only gates AI on a public deployment; the server compares it with AI_ACCESS_CODE.
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    const value = encodeURIComponent(aiCode.trim());
    document.cookie = `moona-ai-access=${value}; path=/; max-age=31536000; samesite=lax${secure}`;
    setAiSaved(true);
  }

  return (
    <div className="stack gap-32" style={{ maxWidth: 760 }}>
      <h1 className="h1">{m.me.title}</h1>
      {!storageOk && <p className="notice">{m.common.storageOff}</p>}

      <section className="panel stack gap-8">
        <h2 className="h3">{m.me.birthTitle}</h2>
        {bigThree ? <p style={{ margin: 0 }}>{bigThree}</p> : <p className="muted small" style={{ margin: 0 }}>{m.me.birthDev}</p>}
        <div className="btn-row">
          <Link href={birth ? "/chart" : "/chart/edit"} className="btn btn-ghost">{birth ? m.chart.title : m.chart.add}</Link>
          {birth && <button type="button" className="btn-text" onClick={() => window.confirm(m.me.confirmRemoveBirth) && clearBirth()}>{m.me.removeBirth}</button>}
        </div>
      </section>

      <section className="panel">
        <h2 className="h2" style={{ marginBottom: 8 }}>{m.me.settings}</h2>
        <div className="setting">
          <span>{m.me.language}</span>
          <div className="btn-row" role="group" aria-label={m.me.language}>
            <button type="button" className="chip" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>English</button>
            <button type="button" className="chip" aria-pressed={locale === "zh"} onClick={() => setLocale("zh")}>中文</button>
          </div>
        </div>
        <div className="setting">
          <span className="stack">
            <span id="rev-label">{m.me.reversals}</span>
            <span className="muted small">{m.me.reversalsDesc}</span>
          </span>
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={settings.reversals}
            aria-labelledby="rev-label"
            onClick={() => updateSettings({ reversals: !settings.reversals })}
          />
        </div>
        <div className="setting">
          <label className="stack" htmlFor="region">
            <span>{m.me.region}</span>
            <span className="muted small">{m.me.regionDesc}</span>
          </label>
          <select
            id="region"
            className="select"
            value={settings.helpRegion}
            onChange={(e) => updateSettings({ helpRegion: e.target.value as Settings["helpRegion"] })}
          >
            <option value="auto">{fmt(m.me.regionAuto, { guess: regionName(guess) })}</option>
            <option value="US">{m.me.regionUS}</option>
            <option value="other">{m.me.regionOther}</option>
          </select>
        </div>
        <div className="setting">
          <label className="stack" htmlFor="ai-code">
            <span>{m.me.aiAccess}</span>
            <span className="muted small">{aiSaved ? m.me.aiAccessSaved : m.me.aiAccessDesc}</span>
          </label>
          <span style={{ display: "flex", gap: 8 }}>
            <input id="ai-code" className="input" style={{ width: 160 }} type="password" autoComplete="off" value={aiCode} onChange={(e) => { setAiCode(e.target.value); setAiSaved(false); }} />
            <button type="button" className="btn btn-ghost" onClick={saveAiCode}>OK</button>
          </span>
        </div>
      </section>

      <section className="stack gap-12">
        <h2 className="h2">{m.me.history}</h2>
        {readings.length ? <ReadingList readings={readings} onDelete={(id) => window.confirm(m.me.confirmDeleteReading) && deleteReading(id)} /> : <p className="muted">{m.me.empty}</p>}
      </section>

      <NotesManager />

      <section className="stack gap-12" aria-labelledby="favorites-title">
        <h2 className="h2" id="favorites-title">{m.learn.favoritesTitle}</h2>
        {favorites.length ? (
          <ul className="stack gap-4" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {favorites.map((f) => {
              const e = getEntry(f.type, f.slug);
              if (!e) return null;
              return (
                <li key={`${f.type}/${f.slug}`} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <Link href={learnHref(f.type as LearnType, f.slug)}>{pick(e.title)}</Link>
                  <span className="muted small">{m.learn.types[e.type]}</span>
                  <button type="button" className="btn-text" style={{ padding: 0, minHeight: 0 }} onClick={() => toggleFavorite(f.type, f.slug)}>{m.common.delete}</button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted" style={{ margin: 0 }}>{m.learn.favoritesEmpty}</p>
        )}
      </section>

      <section className="stack gap-12" aria-labelledby="checkins-title">
        <h2 className="h2" id="checkins-title">{m.checkin.listTitle}</h2>
        {checkIns.length ? (
          <ul className="stack gap-8" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {checkIns.map((c) => <CheckInItem key={c.id} c={c} showReadingLink />)}
          </ul>
        ) : (
          <p className="muted" style={{ margin: 0 }}>{m.checkin.none}</p>
        )}
      </section>

      <section className="stack gap-12">
        <p className="muted small" style={{ margin: 0 }}>{m.me.privacy}</p>
        <div className="btn-row">
          <button type="button" className="btn btn-ghost" onClick={download}>{m.me.export}</button>
          <button type="button" className="btn-text" onClick={() => window.confirm(m.me.confirmClear) && clearLocalData()}>{m.me.clear}</button>
        </div>
      </section>
    </div>
  );
}
