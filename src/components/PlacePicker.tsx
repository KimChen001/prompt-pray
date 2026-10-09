"use client";
// Birthplace picker: searches our own /api/places (GeoNames) or takes coordinates + IANA time zone.
// Shared by the birth form and Match. Only the typed city name is sent to the server.
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { isValidTimeZone, type BirthPlace } from "@/lib/astro/birth";
import type { PlaceResult } from "@/lib/astro/places";

export function usePlaceLabel() {
  const { locale } = useI18n();
  const regionName = useMemo(() => {
    const dn = new Intl.DisplayNames([locale === "zh" ? "zh-CN" : "en"], { type: "region" });
    return (cc: string) => {
      try {
        return cc ? dn.of(cc) ?? cc : "";
      } catch {
        return cc;
      }
    };
  }, [locale]);
  return (p: BirthPlace) => [locale === "zh" && p.zh ? p.zh : p.name, p.admin1, regionName(p.country)].filter(Boolean).join(", ");
}

export function PlacePicker({ id, value, onChange }: { id: string; value: BirthPlace | null; onChange: (p: BirthPlace | null) => void }) {
  const { m } = useI18n();
  const placeLabel = usePlaceLabel();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "error" | "done">("idle");
  const [manual, setManual] = useState(false);
  const [mLat, setMLat] = useState("");
  const [mLon, setMLon] = useState("");
  const [mTz, setMTz] = useState("");

  // Debounced place search; the query goes only to our own /api/places.
  useEffect(() => {
    if (value || manual || query.trim().length < 2) {
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
  }, [query, value, manual]);

  const tzValid = mTz.trim() !== "" && isValidTimeZone(mTz.trim());
  const latN = Number(mLat);
  const lonN = Number(mLon);
  const manualValid = mLat !== "" && mLon !== "" && Math.abs(latN) <= 90 && Math.abs(lonN) <= 180 && tzValid;

  if (value) {
    return (
      <div className="picked">
        <span>
          <strong style={{ fontWeight: 500 }}>{placeLabel(value)}</strong>
          <span className="meta meta-raw" style={{ display: "block" }}>
            {value.lat.toFixed(4)}, {value.lon.toFixed(4)} · {value.tz}
          </span>
        </span>
        <button type="button" className="btn-text" onClick={() => { onChange(null); setQuery(""); }}>{m.birthForm.change}</button>
      </div>
    );
  }
  if (manual) {
    return (
      <div className="stack gap-2">
        <div className="field-row">
          <input className="input" inputMode="decimal" placeholder={m.birthForm.lat} aria-label={m.birthForm.lat} value={mLat} onChange={(e) => setMLat(e.target.value)} />
          <input className="input" inputMode="decimal" placeholder={m.birthForm.lon} aria-label={m.birthForm.lon} value={mLon} onChange={(e) => setMLon(e.target.value)} />
        </div>
        <input className="input" placeholder={m.birthForm.tz} aria-label={m.birthForm.tz} value={mTz} onChange={(e) => setMTz(e.target.value)} />
        {mTz && !tzValid && <span className="field-error">{m.birthForm.tzInvalid}</span>}
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!manualValid}
            onClick={() => {
              if (!manualValid) return;
              onChange({ name: m.birthForm.manualName, country: "", lat: latN, lon: lonN, tz: mTz.trim() });
              setManual(false);
            }}
          >
            {m.birthForm.useManual}
          </button>
          <button type="button" className="btn-text" onClick={() => setManual(false)}>{m.common.back}</button>
        </div>
      </div>
    );
  }
  return (
    <>
      <input id={id} className="input" autoComplete="off" placeholder={m.birthForm.placeHint} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div aria-live="polite">
        {searchState === "loading" && <span className="muted small">{m.birthForm.searching}</span>}
        {searchState === "error" && <span className="field-error">{m.birthForm.searchError}</span>}
        {searchState === "done" && results.length === 0 && <span className="muted small">{m.birthForm.noResults}</span>}
      </div>
      {results.length > 0 && (
        <ul className="results" role="listbox" aria-label={m.birthForm.place}>
          {results.map((r, i) => (
            <li key={`${r.name}-${r.lat}-${i}`}>
              <button type="button" role="option" aria-selected={false} onClick={() => onChange({ name: r.name, admin1: r.admin1, country: r.country, lat: r.lat, lon: r.lon, tz: r.tz, zh: r.zh })}>
                {placeLabel(r)}
                <span className="meta meta-raw">{r.tz}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn-text" style={{ alignSelf: "flex-start" }} onClick={() => setManual(true)}>{m.birthForm.manual}</button>
    </>
  );
}
