"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import {
  clearLocalData, deleteReading, exportLocalData, getSettings, listReadings, storageAvailable, updateSettings, useStoreVersion, type Settings,
} from "@/lib/store";
import { guessHelpRegion } from "@/lib/safety";
import { userTimeZone } from "@/lib/time";
import type { Reading } from "@/lib/tarot/types";
import { ReadingList } from "@/components/ReadingList";
import { SourceBadge } from "@/components/bits";

export default function MePage() {
  const { m, fmt, locale, setLocale } = useI18n();
  const version = useStoreVersion();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [storageOk, setStorageOk] = useState(true);
  const [guess, setGuess] = useState<"US" | "other">("other");

  useEffect(() => {
    setSettings(getSettings());
    setReadings(listReadings());
    setStorageOk(storageAvailable());
    setGuess(guessHelpRegion(userTimeZone()));
  }, [version]);

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

  return (
    <div className="stack gap-32" style={{ maxWidth: 760 }}>
      <h1 className="h1">{m.me.title}</h1>
      {!storageOk && <p className="notice">{m.common.storageOff}</p>}

      <section className="panel stack gap-8">
        <SourceBadge source="dev" />
        <h2 className="h3">{m.me.birthTitle}</h2>
        <p className="muted small" style={{ margin: 0 }}>{m.me.birthDev}</p>
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
      </section>

      <section className="stack gap-12">
        <h2 className="h2">{m.me.history}</h2>
        {readings.length ? <ReadingList readings={readings} onDelete={deleteReading} /> : <p className="muted">{m.me.empty}</p>}
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
