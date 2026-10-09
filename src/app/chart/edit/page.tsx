"use client";
// Birth details form (plan v0.2 §3.1; Figma: "Birth Details / Desktop 1440" + "Mobile 390").
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { getBirth, saveBirth } from "@/lib/store";
import { formatOffset, resolveLocal, zoneAbbreviation, type BirthPlace } from "@/lib/astro/birth";
import { formatLocalDate, localDateKey } from "@/lib/time";
import { PlacePicker } from "@/components/PlacePicker";

export default function BirthFormPage() {
  const { m, fmt, locale } = useI18n();
  const router = useRouter();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [unknownTime, setUnknownTime] = useState(false);
  const [place, setPlace] = useState<BirthPlace | null>(null);
  const [offsetChoice, setOffsetChoice] = useState<number | undefined>(undefined);
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

  const canSave = dateValid && !!place && (unknownTime || /^\d{2}:\d{2}$/.test(time));
  function save() {
    setSubmitted(true);
    if (!canSave || !place) return;
    saveBirth({ date, time: unknownTime ? null : time, place, offsetChoice: resolution?.status === "ambiguous" ? offsetChoice ?? resolution.options[0].offset : undefined });
    router.push("/chart/reveal");
  }

  // Figma: "UTC−4 (EDT)"
  const zoneLabel = (utc: Date, offset: number) => {
    const abbr = place ? zoneAbbreviation(utc, place.tz) : null;
    return abbr ? `${formatOffset(offset)} (${abbr})` : formatOffset(offset);
  };
  const placeShort = place ? (locale === "zh" && place.zh ? place.zh : place.name) : "";

  return (
    <div className="form-page">
      <header className="page-head page-head-center">
        <p className="ornament" aria-hidden="true">{"✦   ───────   ✦   ───────   ✦"}</p>
        <p className="eyebrow" style={{ marginTop: 18 }}>{m.birthForm.eyebrow}</p>
        <h1 className="h1" style={{ fontSize: "clamp(34px, 5vw, 52px)" }}>{m.birthForm.heading}</h1>
        <p className="lede">{m.birthForm.sub}</p>
      </header>

      <form className="form-card" onSubmit={(e) => { e.preventDefault(); save(); }} noValidate>
        <div className="field">
          <label htmlFor="bdate">{m.birthForm.date}</label>
          <input id="bdate" className="input" type="date" min="1900-01-01" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
          {submitted && date && !dateValid && <span className="field-error">{m.birthForm.invalidDate}</span>}
        </div>

        <div className="stack gap-2">
          <div className="field">
            <label htmlFor="btime">{m.birthForm.time}</label>
            <input id="btime" className="input" type="time" value={time} disabled={unknownTime} onChange={(e) => setTime(e.target.value)} />
          </div>
          <label className="toggle-row">
            <span>{m.birthForm.unknownTime}</span>
            <input type="checkbox" checked={unknownTime} onChange={(e) => setUnknownTime(e.target.checked)} />
            <span className="toggle-state" aria-hidden="true">{unknownTime ? m.birthForm.toggleOn : m.birthForm.toggleOff}</span>
          </label>
          <span className="muted" style={{ fontSize: 12 }}>{m.birthForm.timeHint}</span>
        </div>

        <div className="field">
          <label htmlFor="bplace">{m.birthForm.place}</label>
          <PlacePicker id="bplace" value={place} onChange={(p) => { setPlace(p); setOffsetChoice(undefined); }} />
        </div>

        {resolution?.status === "ambiguous" && (
          <fieldset className="stack gap-2" style={{ border: 0, padding: 0, margin: 0 }} aria-live="polite">
            <legend className="small" style={{ marginBottom: 8 }}>{m.birthForm.ambiguous}</legend>
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
        {resolution?.status === "nonexistent" && (
          <p className="notice" style={{ margin: 0 }}>{fmt(m.birthForm.nonexistent, { time, suggested: resolution.suggestedTime })}</p>
        )}

        <hr className="hairline" />

        <div className="form-confirm" aria-live="polite">
          {place && dateValid && resolution?.status === "ok" && (
            <span>{fmt(m.birthForm.bornLine, { local: `${formatLocalDate(date, locale)}, ${time}`, place: placeShort, offset: zoneLabel(resolution.result.utc, resolution.result.offset) })}</span>
          )}
          {place && dateValid && unknownTime && <span>{fmt(m.birthForm.bornNoTime, { date: formatLocalDate(date, locale), place: placeShort })}</span>}
          <span>{m.chart.privacy}</span>
        </div>

        {submitted && !canSave && <p className="field-error" style={{ margin: 0 }}>{m.birthForm.required}</p>}
        <button type="submit" className="btn btn-primary btn-lg btn-block">{m.birthForm.reveal} <span aria-hidden="true">→</span></button>
      </form>
    </div>
  );
}
