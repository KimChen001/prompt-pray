"use client";
// Daily horoscope: template text from real transits immediately, AI rewrite when available.
// Functional build; visual design pending.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { cacheHoroscope, getBirth, getCachedHoroscope, getSettings, updateSettings, useStoreVersion, type CachedText } from "@/lib/store";
import { computeChart } from "@/lib/astro/chart";
import { skyForDay } from "@/lib/astro/sky";
import { dailyFacts, type Subject } from "@/lib/astro/transits";
import { composeHoroscope } from "@/lib/astro/horoscope";
import { SIGNS, SIGN_INFO, type Sign } from "@/lib/astro/zodiac";
import type { BirthData } from "@/lib/astro/birth";
import { SourceBadge } from "./bits";

type AiState = { status: "idle" | "loading" | "live" | "failed" | "off"; text?: CachedText };

export function HoroscopePanel({ localDate, timeZone, now }: { localDate: string; timeZone: string; now: Date }) {
  const { m, fmt, pick, locale } = useI18n();
  const version = useStoreVersion();
  const [birth, setBirth] = useState<BirthData | null | undefined>(undefined);
  const [sunSign, setSunSign] = useState<Sign | null>(null);
  const [ai, setAi] = useState<AiState>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setBirth(getBirth());
    setSunSign(getSettings().sunSign);
  }, [version]);

  // Facts depend on the local day, not the minute: recompute only when the day changes.
  const dayKey = `${localDate}|${timeZone}`;
  const result = useMemo(() => {
    if (birth === undefined) return null;
    let subject: Subject | null = null;
    let names: { sun?: string; moon?: string; rising?: string } = {};
    let subjectKey = "";
    if (birth) {
      const natal = computeChart(birth, getSettings().houseSystem);
      const b = natal.bigThree;
      const sign = (s?: Sign) => (s ? SIGN_INFO[s].name.en : undefined);
      subject = { mode: "natal", sunSign: natal.positions.sun.placement.sign, natal };
      names = {
        sun: sign(b.sun.placement?.sign ?? b.sun.options?.[0]),
        moon: b.moon.placement ? sign(b.moon.placement.sign) : b.moon.options ? `${sign(b.moon.options[0])} or ${sign(b.moon.options[1])}` : undefined,
        rising: sign(b.rising?.placement?.sign),
      };
      subjectKey = `natal:${birth.date}:${birth.time ?? "-"}:${birth.place.lat},${birth.place.lon}`;
    } else if (sunSign) {
      subject = { mode: "sign", sunSign };
      names = { sun: SIGN_INFO[sunSign].name.en };
      subjectKey = `sign:${sunSign}`;
    }
    if (!subject) return null;
    const sky = skyForDay(localDate, timeZone, now);
    const facts = dailyFacts(subject, sky);
    return { subject, names, subjectKey, facts, horoscope: composeHoroscope(facts) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` only matters through the day key
  }, [birth, sunSign, dayKey]);

  const cacheKey = result ? `${localDate}|${result.subjectKey}|${locale}` : null;

  const askAi = useCallback(async () => {
    if (!result || !cacheKey) return;
    const cached = getCachedHoroscope(cacheKey);
    if (cached) return setAi({ status: "live", text: cached });
    setAi({ status: "loading" });
    try {
      const res = await fetch("/api/ai/horoscope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locale,
          date: localDate,
          tone: result.horoscope.tone,
          subject: result.names,
          facts: result.horoscope.why.map((w) => w.line[locale]),
        }),
      });
      if (res.status === 503) return setAi({ status: "off" }); // not configured or locked: template only, no warning
      if (!res.ok) return setAi({ status: "failed" });
      const body = (await res.json()) as CachedText;
      cacheHoroscope(cacheKey, { overall: body.overall, love: body.love, work: body.work });
      setAi({ status: "live", text: body });
    } catch {
      setAi({ status: "failed" });
    }
  }, [result, cacheKey, locale, localDate]);

  useEffect(() => {
    void askAi();
  }, [askAi, attempt]);

  if (birth === undefined) return null;

  if (!result) {
    return (
      <section className="panel stack gap-12">
        <h2 className="h3">{m.horoscope.title}</h2>
        <p style={{ margin: 0 }}>{m.horoscope.pickSign}</p>
        <div className="btn-row" role="group" aria-label={m.horoscope.pickSign}>
          {SIGNS.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => updateSettings({ sunSign: s })}>
              {SIGN_INFO[s].glyph}&#xFE0E; {pick(SIGN_INFO[s].name)}
            </button>
          ))}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          {m.horoscope.pickHint} <Link href="/chart/edit">{m.horoscope.addBirth}</Link>
        </p>
      </section>
    );
  }

  const h = result.horoscope;
  const live = ai.status === "live" && ai.text;
  const text = live ? ai.text! : { overall: pick(h.overall), love: pick(h.love), work: pick(h.work) };

  return (
    <section className="panel stack gap-16" aria-labelledby="horoscope-title" aria-busy={ai.status === "loading"}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h2 className="h3" id="horoscope-title">{m.horoscope.title}</h2>
        <SourceBadge source={live ? "live" : "template"} />
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="badge">{m.horoscope.tones[h.tone]}</span>
        <span className="muted small">
          {result.subject.mode === "natal" ? m.horoscope.personal : fmt(m.horoscope.bySign, { sign: pick(SIGN_INFO[result.subject.sunSign].name) })}
        </span>
        {result.subject.mode === "sign" && (
          <button type="button" className="btn-text" style={{ minHeight: 0, padding: 0 }} onClick={() => updateSettings({ sunSign: null })}>{m.horoscope.change}</button>
        )}
      </div>

      {(["overall", "love", "work"] as const).map((k) => (
        <div key={k} className="stack gap-4">
          <span className="meta">{m.horoscope[k]}</span>
          <p style={{ margin: 0 }}>{text[k]}</p>
        </div>
      ))}

      {ai.status === "loading" && <p className="muted small" style={{ margin: 0 }}>{m.horoscope.loadingAi}</p>}
      {ai.status === "failed" && (
        <p className="notice" style={{ margin: 0 }}>
          {m.horoscope.aiFallback}{" "}
          <button type="button" className="btn-text" style={{ minHeight: 0, padding: 0 }} onClick={() => setAttempt((n) => n + 1)}>{m.horoscope.retry}</button>
        </p>
      )}

      <details>
        <summary className="meta" style={{ cursor: "pointer" }}>{m.horoscope.why}</summary>
        <ul style={{ margin: "8px 0 0", paddingLeft: 20, color: "var(--text-2)" }}>
          {h.why.map((w, i) => <li key={i} className="small">{pick(w.line)}</li>)}
        </ul>
      </details>
    </section>
  );
}
