"use client";
// Daily horoscope: template text from real transits immediately, AI rewrite when available.
// - Facts use the day's fixed reference moment, so the template, the AI request and any saved text
//   describe the same sky (lib/astro/horoscope-day.ts).
// - Saved AI text is keyed by every input (birth details incl. DST choice and zone, house system,
//   the person's time zone, rules/prompt versions, language) and shown with the facts it came from.
// - A response that arrives after the language, birth details or day changed is dropped.
// - Unknown birth time: both candidate signs, no Rising, houses counted from the Sun sign and labelled.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { cacheHoroscope, dataEpoch, getBirth, getCachedHoroscope, getSettings, updateSettings, useStoreVersion, type CachedText } from "@/lib/store";
import { dayHoroscope, horoscopeBody, horoscopeCacheKey, type HoroscopeInput } from "@/lib/astro/horoscope-day";
import { SIGNS, SIGN_INFO, type Sign } from "@/lib/astro/zodiac";
import type { BirthData } from "@/lib/astro/birth";
import type { HouseSystem } from "@/lib/astro/houses";
import { SourceBadge } from "./bits";
import { ZodiacIcon } from "./AstroIcon";

// "live" = generated for this view just now; "saved" = read back from this device's cache.
type AiState = { status: "idle" | "loading" | "live" | "saved" | "failed" | "off"; text?: CachedText; key?: string };

export function HoroscopePanel({ localDate, timeZone, onBusy }: { localDate: string; timeZone: string; onBusy?: (busy: boolean) => void }) {
  const { m, fmt, pick, locale } = useI18n();
  const version = useStoreVersion();
  const [birth, setBirth] = useState<BirthData | null | undefined>(undefined);
  const [sunSign, setSunSign] = useState<Sign | null>(null);
  const [houseSystem, setHouseSystem] = useState<HouseSystem>("placidus");
  const [ai, setAi] = useState<AiState>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  const currentKey = useRef<string | null>(null);

  useEffect(() => {
    setBirth(getBirth());
    const s = getSettings();
    setSunSign(s.sunSign);
    setHouseSystem(s.houseSystem);
  }, [version]);

  const input: HoroscopeInput | null = birth ? { birth, houseSystem } : sunSign ? { sunSign } : null;
  const inputKey = JSON.stringify(input);
  const day = useMemo(() => {
    if (!input) return null;
    try {
      return dayHoroscope(input, localDate, timeZone);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- input is captured by its serialized key
  }, [inputKey, localDate, timeZone]);

  const cacheKey = day ? horoscopeCacheKey(day, localDate, timeZone, locale) : null;
  currentKey.current = cacheKey;

  useEffect(() => {
    if (!day || !cacheKey) return;
    const cached = getCachedHoroscope(cacheKey);
    if (cached) {
      setAi({ status: "saved", text: cached, key: cacheKey });
      return;
    }
    const key = cacheKey;
    const epoch = dataEpoch();
    setAi({ status: "loading", key });
    onBusy?.(true);
    (async () => {
      try {
        const res = await fetch("/api/ai/horoscope", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(horoscopeBody(day, localDate, timeZone, locale)),
        });
        if (currentKey.current !== key || epoch !== dataEpoch()) return; // inputs, language or data changed meanwhile
        if (res.status === 503) return setAi({ status: "off", key }); // not configured or locked: template only
        if (!res.ok) return setAi({ status: "failed", key });
        const body = (await res.json()) as CachedText & { basis?: string[] };
        const text: CachedText = { overall: body.overall, love: body.love, work: body.work, meta: body.meta, basis: body.basis };
        cacheHoroscope(key, text);
        setAi({ status: "live", text, key });
      } catch {
        if (currentKey.current === key) setAi({ status: "failed", key });
      } finally {
        onBusy?.(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one request per key and attempt
  }, [cacheKey, attempt]);

  if (birth === undefined) return null;

  if (!day) {
    return (
      <section className="panel stack gap-3" aria-labelledby="horoscope-title">
        <h2 className="h3" id="horoscope-title">{m.horoscope.title}</h2>
        <p style={{ margin: 0 }}>{m.horoscope.pickSign}</p>
        <div className="btn-row" role="group" aria-label={m.horoscope.pickSign}>
          {SIGNS.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => updateSettings({ sunSign: s })}>
              <ZodiacIcon sign={s} size={16} /> {pick(SIGN_INFO[s].name)}
            </button>
          ))}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          {m.horoscope.pickHint} <Link href="/chart/edit">{m.horoscope.addBirth}</Link>
        </p>
      </section>
    );
  }

  const h = day.horoscope;
  const fresh = ai.key === cacheKey;
  const aiText = fresh && (ai.status === "live" || ai.status === "saved") && ai.text ? ai.text : null;
  const text = aiText ?? { overall: pick(h.overall), love: pick(h.love), work: pick(h.work) };
  const why = aiText?.basis?.length ? aiText.basis : h.why.map((w) => pick(w.line));
  const subject = day.subject;
  const uncertainSun = subject.sunOptions && subject.sunOptions.length > 1;

  return (
    <section className="panel stack gap-4" aria-labelledby="horoscope-title" aria-busy={fresh && ai.status === "loading"}>
      <div className="row-between">
        <h2 className="h3" id="horoscope-title">{m.horoscope.title}</h2>
        {aiText ? <SourceBadge source={ai.status === "live" ? "live" : "saved"} time={aiText.meta.generatedAt} title={aiText.meta.model} /> : <SourceBadge source="template" />}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <span className="badge badge-mist">{m.horoscope.tones[h.tone]}</span>
        <span className="muted small">
          {subject.mode === "natal"
            ? subject.natal?.timeKnown ? m.horoscope.personal : m.horoscope.personalNoTime
            : fmt(m.horoscope.bySign, { sign: pick(SIGN_INFO[subject.sunSign!].name) })}
        </span>
        {subject.mode === "sign" && <button type="button" className="btn-link small" onClick={() => updateSettings({ sunSign: null })}>{m.horoscope.change}</button>}
      </div>
      {uncertainSun && (
        <p className="notice-quiet">{fmt(m.horoscope.sunUncertain, { a: pick(SIGN_INFO[subject.sunOptions![0]].name), b: pick(SIGN_INFO[subject.sunOptions![1]].name) })}</p>
      )}

      {(["overall", "love", "work"] as const).map((k) => (
        <div key={k} className="interp-section">
          <span className="meta">{m.horoscope[k]}</span>
          <p>{text[k]}</p>
        </div>
      ))}

      {fresh && ai.status === "loading" && <span className="status-line"><span className="status-dot" />{m.horoscope.loadingAi}</span>}
      {fresh && ai.status === "failed" && (
        <p className="notice">
          {m.horoscope.aiFallback}{" "}
          <button type="button" className="btn-link" onClick={() => setAttempt((n) => n + 1)}>{m.horoscope.retry}</button>
        </p>
      )}

      <details className="panel-quiet">
        <summary className="disclosure-summary" style={{ listStyle: "none", cursor: "pointer" }}>{m.horoscope.why}</summary>
        <ul style={{ margin: "8px 0 0", paddingLeft: 20, color: "var(--text-2)" }}>
          {why.map((line, i) => <li key={i} className="small">{line}</li>)}
        </ul>
        <p className="muted small" style={{ margin: "10px 0 0" }}>{aiText ? m.horoscope.basisAi : m.horoscope.basisTemplate} {m.horoscope.reference}</p>
      </details>
    </section>
  );
}
