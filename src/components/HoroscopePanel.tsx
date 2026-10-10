"use client";
// Daily horoscope: template text from real transits immediately, AI rewrite when available.
// - Facts use the day's fixed reference moment, so the template, the AI request and any saved text
//   describe the same sky (lib/astro/horoscope-day.ts).
// - Saved AI text is keyed by every input (birth details incl. DST choice and zone, house system,
//   the person's time zone, language) and shown with the facts it came from. The rules/prompt/claim
//   versions are stored with it: a text from earlier versions is kept, re-checked against today's facts
//   with the current rules (no model call), and only rewritten when the person asks, never silently.
// - A response that arrives after the language, birth details or day changed is dropped.
// - Unknown birth time: both candidate signs, no Rising, houses counted from the Sun sign and labelled.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { cacheHoroscope, dataEpoch, getBirth, getCachedHoroscope, getSettings, updateSettings, useStoreVersion, type CachedText } from "@/lib/store";
import { dayHoroscope, horoscopeBody, horoscopeCacheKey, savedTextHolds, type HoroscopeInput } from "@/lib/astro/horoscope-day";
import { HOROSCOPE_VERSIONS } from "@/lib/ai/horoscope-prompt";
import { SIGNS, SIGN_INFO, type Sign } from "@/lib/astro/zodiac";
import type { BirthData } from "@/lib/astro/birth";
import type { HouseSystem } from "@/lib/astro/houses";
import { SourceBadge, aiSource } from "./bits";
import { newRequestId, requestAiOnce } from "@/lib/ai/client";
import { ZodiacIcon } from "./AstroIcon";

// "live" = generated for this view just now; "saved" = read back from this device's cache;
// "older" = saved under earlier versions (holds = it still passes the current checks for today's facts).
// `why` = the server's reason when live AI is off (quota, budget, paused), shown under the template.
type AiState = { status: "idle" | "loading" | "live" | "saved" | "older" | "failed" | "off"; text?: CachedText; key?: string; holds?: boolean; why?: string };

export function HoroscopePanel({ localDate, timeZone, onBusy }: { localDate: string; timeZone: string; onBusy?: (busy: boolean) => void }) {
  const { m, fmt, pick, locale } = useI18n();
  const version = useStoreVersion();
  const [birth, setBirth] = useState<BirthData | null | undefined>(undefined);
  const [sunSign, setSunSign] = useState<Sign | null>(null);
  const [houseSystem, setHouseSystem] = useState<HouseSystem>("placidus");
  const [ai, setAi] = useState<AiState>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  // A rewrite the person asked for is one paid attempt for one key. It is used up when its request
  // starts, so coming back to that key later shows the saved text instead of paying again.
  const [rewrite, setRewrite] = useState<{ key: string; n: number } | null>(null);
  const usedRewrite = useRef(0);
  // One request per key at a time: switching away and back while it runs joins it.
  const pending = useRef(new Set<string>());
  const currentKey = useRef<string | null>(null);
  const askRewrite = (key: string) => setRewrite((r) => ({ key, n: (r?.n ?? 0) + 1 }));

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
    // A text saved under the current versions is used as is. An older one is kept, re-checked, and
    // shown until the person asks for a rewrite.
    if (cached && cached.versions === HOROSCOPE_VERSIONS) return setAi({ status: "saved", text: cached, key: cacheKey });
    const holds = cached ? savedTextHolds(cached, day, localDate, timeZone, locale) : false;
    const key = cacheKey;
    // While rewriting, an older text that still holds stays on screen, and stays if the request fails.
    const keep = cached ? { text: cached, holds } : {};
    if (pending.current.has(key)) return setAi({ status: "loading", key, ...keep });
    const asked = rewrite !== null && rewrite.key === key && rewrite.n > usedRewrite.current;
    if (cached && !asked) return setAi({ status: "older", text: cached, key, holds });
    if (asked) usedRewrite.current = rewrite.n;
    const epoch = dataEpoch();
    pending.current.add(key);
    setAi({ status: "loading", key, ...keep });
    onBusy?.(true);
    (async () => {
      try {
        // one id per attempt: a retry inside it (still running, busy) replays rather than pays twice
        const out = await requestAiOnce<CachedText & { basis?: string[] }>("/api/ai/horoscope", horoscopeBody(day, localDate, timeZone, locale) as unknown as Record<string, unknown>, { requestId: newRequestId() });
        if (epoch !== dataEpoch()) return; // data cleared or birth details changed: the result belongs to nobody
        const here = currentKey.current === key;
        if (out.state === "quota") return here && setAi({ status: "off", key, ...keep, why: m.aiNotice.quotaShort });
        if (out.state === "offline" && out.reason !== "network" && out.reason !== "busy") {
          // not configured, locked, budget used up or paused: the template only
          const why = out.reason === "budget" ? m.aiNotice.budgetShort : out.reason === "ledger" || out.reason === "paused" ? m.aiNotice.pausedShort : undefined;
          return here && setAi({ status: "off", key, ...keep, why });
        }
        if (out.state !== "done") return here && setAi({ status: "failed", key, ...keep });
        const body = out.value;
        // An unknown server version stays unknown (it is then treated as older), never assumed current.
        const text: CachedText = { overall: body.overall, love: body.love, work: body.work, meta: body.meta, basis: body.basis, versions: body.versions };
        // A paid result is saved for its own key even if the language or zone changed meanwhile.
        cacheHoroscope(key, text);
        if (here) setAi({ status: "live", text, key });
      } catch {
        if (currentKey.current === key) setAi({ status: "failed", key, ...keep });
      } finally {
        pending.current.delete(key);
        onBusy?.(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one request per key and attempt
  }, [cacheKey, attempt, rewrite]);

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
  const older = fresh && ai.status === "older" && ai.text ? ai.text : null;
  // An older saved text is shown only if it passes the current checks; it stays while a rewrite runs or fails.
  const aiText = fresh && ai.text && (ai.status === "live" || ai.status === "saved" || ai.holds) ? ai.text : null;
  const text = aiText ?? { overall: pick(h.overall), love: pick(h.love), work: pick(h.work) };
  const why = aiText?.basis?.length ? aiText.basis : h.why.map((w) => pick(w.line));
  const subject = day.subject;
  const uncertainSun = subject.sunOptions && subject.sunOptions.length > 1;

  return (
    <section className="panel stack gap-4" aria-labelledby="horoscope-title" aria-busy={fresh && ai.status === "loading"}>
      <div className="row-between">
        <h2 className="h3" id="horoscope-title">{m.horoscope.title}</h2>
        {aiText ? <SourceBadge source={aiSource(aiText.meta, ai.status === "live")} time={aiText.meta.generatedAt} title={aiText.meta.model} /> : <SourceBadge source="template" />}
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

      {older && (
        <p className="notice-quiet">
          {fmt(ai.holds ? m.horoscope.olderHolds : m.horoscope.olderFails, { v: (older.versions ?? m.horoscope.olderUnknown).replaceAll("|", " · ") })}{" "}
          <button type="button" className="btn-link" onClick={() => askRewrite(cacheKey!)}>{m.horoscope.rewrite}</button>
        </p>
      )}
      {fresh && ai.status === "loading" && <span className="status-line"><span className="status-dot" />{m.horoscope.loadingAi}</span>}
      {fresh && ai.status === "off" && ai.why && <p className="muted small" style={{ margin: 0 }}>{ai.why}</p>}
      {fresh && ai.status === "failed" && (
        <p className="notice">
          {m.horoscope.aiFallback}{" "}
          {/* retrying a failed rewrite is a new rewrite the person asks for; otherwise a plain retry */}
          <button type="button" className="btn-link" onClick={() => (ai.text ? askRewrite(cacheKey!) : setAttempt((n) => n + 1))}>{m.horoscope.retry}</button>
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
