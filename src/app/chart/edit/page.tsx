"use client";
// Birth details form (plan v0.2 §3.1). Functional build — visual design comes later.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { getBirth, saveBirth } from "@/lib/store";
import { formatOffset, isValidTimeZone, resolveLocal, zoneAbbreviation, type BirthPlace } from "@/lib/astro/birth";
import { formatLocalDate, localDateKey } from "@/lib/time";
import type { PlaceResult } from "@/lib/astro/places";

export default function BirthFormPage() {
  const { m, fmt, locale } = useI18n();
  const router = useRouter();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [unknownTime, setUnknownTime] = useState(false);
  const [place, setPlace] = useState<BirthPlace | null>(null);
  const [offsetChoice, setOffsetChoice] = useState<number | undefined>(undefined);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "error" | "done">("idle");
  const [manual, setManual] = useState(false);
  const [mLat, setMLat] = useState("");
  const [mLon, setMLon] = useState("");
  const [mTz, setMTz] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const b = getBirth();
    if (!b) return;
    setDate(b.date);
    setTime(b.time ?? "");
    setUnknownTime(!b.time);
    setPlace(b.place);
    setOffsetChoice(b.offsetChoice);
  }, []);

  // Debounced place search; the query goes only to our own /api/places.
  useEffect(() => {
    if (place || manual || query.trim().length < 2) {
      setResults([]);
      setSearchState("idle");
      return;
    }
    const ctrl = new AbortController();
    setSearchState("loading");
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/places?q=${encodeURIComponent(query.trim())}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(String(res.status));
        setResults((await res.json()).results);
        setSearchState("done");
      } catch (e) {
        if ((e as Error).name !== "AbortError") setSearchState("error");
      }
    }, 250);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [query, place, manual]);

  const regionName = useMemo(() => {
    const dn = new Intl.DisplayNames([locale === "zh" ? "zh-CN" : "en"], { type: "region" });
    return (cc: string) => {
      try {
        return dn.of(cc) ?? cc;
      } catch {
        return cc;
      }
    };
  }, [locale]);

  const placeLabel = (p: BirthPlace) =>
    [locale === "zh" && p.zh ? p.zh : p.name, p.admin1, regionName(p.country)].filter(Boolean).join(", ");

  const today = localDateKey();
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= "1900-01-01" && date <= today;
  const resolution = useMemo(() => {
    if (!dateValid || !place || unknownTime || !/^\d{2}:\d{2}$/.test(time)) return null;
    try {
      return resolveLocal(date, time, place.tz);
    } catch {
      return null;
    }
  }, [date, time, place, unknownTime, dateValid]);

  const tzValid = mTz.trim() !== "" && isValidTimeZone(mTz.trim());
  const latN = Number(mLat);
  const lonN = Number(mLon);
  const manualValid = mLat !== "" && mLon !== "" && Math.abs(latN) <= 90 && Math.abs(lonN) <= 180 && tzValid;

  function useManualPlace() {
    if (!manualValid) return;
    setPlace({ name: m.birthForm.manualName, country: "", lat: latN, lon: lonN, tz: mTz.trim() });
    setManual(false);
  }

  const canSave = dateValid && !!place && (unknownTime || /^\d{2}:\d{2}$/.test(time));
  function save() {
    setSubmitted(true);
    if (!canSave || !place) return;
    saveBirth({ date, time: unknownTime ? null : time, place, offsetChoice: resolution?.status === "ambiguous" ? offsetChoice ?? resolution.options[0].offset : undefined });
    router.push("/chart");
  }

  const zoneLabel = (utc: Date, offset: number) => {
    const abbr = place ? zoneAbbreviation(utc, place.tz) : null;
    return abbr ? `${abbr}, ${formatOffset(offset)}` : formatOffset(offset);
  };

  return (
    <div className="stack gap-24" style={{ maxWidth: 640 }}>
      <div className="stack gap-8">
        <h1 className="h1">{m.birthForm.title}</h1>
        <p className="lede">{m.birthForm.intro}</p>
      </div>

      <div className="field">
        <label htmlFor="bdate">{m.birthForm.date}</label>
        <input id="bdate" className="input" type="date" min="1900-01-01" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
        {submitted && date && !dateValid && <span className="field-error">{m.birthForm.invalidDate}</span>}
      </div>

      <div className="field">
        <label htmlFor="btime">{m.birthForm.time}</label>
        <input id="btime" className="input" type="time" value={time} disabled={unknownTime} onChange={(e) => setTime(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={unknownTime} onChange={(e) => setUnknownTime(e.target.checked)} />
          {m.birthForm.unknownTime}
        </label>
        <span className="muted small">{m.birthForm.timeHint}</span>
      </div>

      <div className="field">
        <label htmlFor="bplace">{m.birthForm.place}</label>
        {place ? (
          <div className="picked">
            <span>
              <strong style={{ fontWeight: 500 }}>{placeLabel(place)}</strong>
              <span className="meta meta-raw" style={{ display: "block" }}>
                {place.lat.toFixed(4)}, {place.lon.toFixed(4)} · {place.tz}
              </span>
            </span>
            <button type="button" className="btn-text" onClick={() => { setPlace(null); setQuery(""); setOffsetChoice(undefined); }}>{m.birthForm.change}</button>
          </div>
        ) : manual ? (
          <div className="stack gap-8">
            <div className="field-row">
              <input className="input" inputMode="decimal" placeholder={m.birthForm.lat} aria-label={m.birthForm.lat} value={mLat} onChange={(e) => setMLat(e.target.value)} />
              <input className="input" inputMode="decimal" placeholder={m.birthForm.lon} aria-label={m.birthForm.lon} value={mLon} onChange={(e) => setMLon(e.target.value)} />
            </div>
            <input className="input" placeholder={m.birthForm.tz} aria-label={m.birthForm.tz} value={mTz} onChange={(e) => setMTz(e.target.value)} />
            {mTz && !tzValid && <span className="field-error">{m.birthForm.tzInvalid}</span>}
            <div className="btn-row">
              <button type="button" className="btn btn-ghost" disabled={!manualValid} onClick={useManualPlace}>{m.birthForm.useManual}</button>
              <button type="button" className="btn-text" onClick={() => setManual(false)}>{m.common.back}</button>
            </div>
          </div>
        ) : (
          <>
            <input id="bplace" className="input" autoComplete="off" placeholder={m.birthForm.placeHint} value={query} onChange={(e) => setQuery(e.target.value)} />
            <div aria-live="polite">
              {searchState === "loading" && <span className="muted small">{m.birthForm.searching}</span>}
              {searchState === "error" && <span className="field-error">{m.birthForm.searchError}</span>}
              {searchState === "done" && results.length === 0 && <span className="muted small">{m.birthForm.noResults}</span>}
            </div>
            {results.length > 0 && (
              <ul className="results" role="listbox" aria-label={m.birthForm.place}>
                {results.map((r, i) => (
                  <li key={`${r.name}-${r.lat}-${i}`}>
                    <button type="button" role="option" aria-selected={false} onClick={() => setPlace({ name: r.name, admin1: r.admin1, country: r.country, lat: r.lat, lon: r.lon, tz: r.tz, zh: r.zh })}>
                      {placeLabel(r)}
                      <span className="meta meta-raw">{r.tz}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="btn-text" style={{ alignSelf: "flex-start" }} onClick={() => setManual(true)}>{m.birthForm.manual}</button>
          </>
        )}
      </div>

      {resolution && place && (
        <div className="panel stack gap-8" aria-live="polite">
          {resolution.status === "ok" && (
            <p style={{ margin: 0 }}>
              {fmt(m.birthForm.resolved, { local: `${formatLocalDate(date, locale)} ${time}`, place: placeLabel(place), offset: zoneLabel(resolution.result.utc, resolution.result.offset) })}
            </p>
          )}
          {resolution.status === "ambiguous" && (
            <fieldset className="stack gap-8" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ marginBottom: 8 }}>{m.birthForm.ambiguous}</legend>
              {resolution.options.map((o, i) => (
                <label key={o.offset} className="check">
                  <input
                    type="radio"
                    name="offset"
                    checked={(offsetChoice ?? resolution.options[0].offset) === o.offset}
                    onChange={() => setOffsetChoice(o.offset)}
                  />
                  {fmt(i === 0 ? m.birthForm.first : m.birthForm.second, { time, zone: zoneLabel(o.utc, o.offset) })}
                </label>
              ))}
            </fieldset>
          )}
          {resolution.status === "nonexistent" && (
            <p className="notice" style={{ margin: 0 }}>{fmt(m.birthForm.nonexistent, { time, suggested: resolution.suggestedTime })}</p>
          )}
        </div>
      )}

      {submitted && !canSave && <p className="field-error">{m.birthForm.required}</p>}
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={save}>{m.birthForm.save}</button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>{m.chart.privacy}</p>
    </div>
  );
}
