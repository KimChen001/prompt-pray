"use client";
// Birth details form (plan v0.2 §3.1). Functional build — visual design comes later.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { getBirth, saveBirth } from "@/lib/store";
import { formatOffset, resolveLocal, zoneAbbreviation, type BirthPlace } from "@/lib/astro/birth";
import { formatLocalDate, localDateKey } from "@/lib/time";
import { PlacePicker, usePlaceLabel } from "@/components/PlacePicker";

export default function BirthFormPage() {
  const { m, fmt, locale } = useI18n();
  const router = useRouter();
  const placeLabel = usePlaceLabel();
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
        <PlacePicker id="bplace" value={place} onChange={(p) => { setPlace(p); setOffsetChoice(undefined); }} />
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
