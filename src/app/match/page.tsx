"use client";
// Match input (plan v0.2 §3.5), same-device version: both people's details stay in this browser.
// Remote invites need a backend and are an open product decision, so they are not built here.
// Functional build; visual design pending.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { getBirth, listMatches, saveMatch, useStoreVersion, type SavedMatch } from "@/lib/store";
import { computeMatch, validMatchPerson, type MatchPerson } from "@/lib/astro/match";
import type { BirthData, BirthPlace } from "@/lib/astro/birth";
import { computeChart, type SignCandidate } from "@/lib/astro/chart";
import { SIGN_INFO } from "@/lib/astro/zodiac";
import { localDateKey } from "@/lib/time";
import { PlacePicker } from "@/components/PlacePicker";
import { MatchList } from "@/components/MatchParts";

interface Draft {
  name: string;
  date: string;
  time: string;
  place: BirthPlace | null;
}
const empty: Draft = { name: "", date: "", time: "", place: null };
const toPerson = (d: Draft): MatchPerson => ({ name: d.name.trim(), date: d.date, time: d.time && d.place ? d.time : null, place: d.place });

function PersonFields({ id, draft, onChange, withName }: { id: string; draft: Draft; onChange: (d: Draft) => void; withName?: boolean }) {
  const { m } = useI18n();
  const today = localDateKey();
  return (
    <div className="stack gap-12">
      {withName && (
        <div className="field">
          <label htmlFor={`${id}-name`}>{m.match.nickname}</label>
          <input id={`${id}-name`} className="input" maxLength={24} placeholder={m.match.nicknamePlaceholder} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
        </div>
      )}
      <div className="field">
        <label htmlFor={`${id}-date`}>{m.match.date}</label>
        <input id={`${id}-date`} className="input" type="date" min="1900-01-01" max={today} value={draft.date} onChange={(e) => onChange({ ...draft, date: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-time`}>{m.match.time}</label>
        <input id={`${id}-time`} className="input" type="time" value={draft.time} onChange={(e) => onChange({ ...draft, time: e.target.value })} />
        {draft.time && !draft.place && <span className="muted small">{m.match.timeNeedsPlace}</span>}
      </div>
      <div className="field">
        <label htmlFor={`${id}-place`}>{m.match.place}</label>
        <PlacePicker id={`${id}-place`} value={draft.place} onChange={(place) => onChange({ ...draft, place })} />
      </div>
    </div>
  );
}

export default function MatchPage() {
  const { m, fmt, pick } = useI18n();
  const router = useRouter();
  const version = useStoreVersion();
  const [profile, setProfile] = useState<BirthData | null | undefined>(undefined);
  const [ownDetails, setOwnDetails] = useState(false);
  const [a, setA] = useState<Draft>(empty);
  const [b, setB] = useState<Draft>(empty);
  const [error, setError] = useState(false);
  const [matches, setMatches] = useState<SavedMatch[]>([]);

  useEffect(() => {
    setProfile(getBirth());
    setMatches(listMatches());
  }, [version]);

  if (profile === undefined) return null;
  const useProfile = !!profile && !ownDetails;

  const summary = (() => {
    if (!profile) return "";
    const big = computeChart(profile).bigThree;
    const show = (c: SignCandidate | null) =>
      !c ? "?" : c.placement ? pick(SIGN_INFO[c.placement.sign].name) : c.options ? c.options.map((s) => pick(SIGN_INFO[s].name)).join(" / ") : "?";
    return `${m.chart.sun} ${show(big.sun)} · ${m.chart.moon} ${show(big.moon)} · ${m.chart.rising} ${show(big.rising)}`;
  })();

  function compare() {
    const today = localDateKey();
    const pa: MatchPerson = useProfile
      ? { name: "", date: profile!.date, time: profile!.time, place: profile!.place, offsetChoice: profile!.offsetChoice }
      : toPerson(a);
    const pb = toPerson(b);
    if (!validMatchPerson(pa, today) || !validMatchPerson(pb, today)) return setError(true);
    const saved: SavedMatch = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      a: useProfile ? { fromProfile: true, name: "" } : { fromProfile: false, ...pa },
      b: pb,
      result: computeMatch(pa, pb),
    };
    const persisted = saveMatch(saved);
    router.push(`/match/r/${saved.id}${persisted ? "" : "?local=0"}`);
  }

  return (
    <div className="stack gap-32" style={{ maxWidth: 680 }}>
      <header className="page-head">
        <p className="eyebrow">{m.nav.match}</p>
        <h1 className="h1">{m.match.title}</h1>
        <p className="lede">{m.match.subtitle}</p>
        <p className="notice-quiet" style={{ marginTop: 6 }}>{m.match.sameDeviceNote}</p>
      </header>

      <section className="panel stack gap-12" aria-labelledby="match-you">
        <h2 className="h3" id="match-you">{m.match.you}</h2>
        {useProfile ? (
          <>
            <p style={{ margin: 0 }}>{fmt(m.match.fromProfile, { bigThree: summary })}</p>
            <div><button type="button" className="btn-text" style={{ padding: 0 }} onClick={() => setOwnDetails(true)}>{m.match.enterOwn}</button></div>
          </>
        ) : (
          <>
            {profile ? (
              <div><button type="button" className="btn-text" style={{ padding: 0 }} onClick={() => setOwnDetails(false)}>{m.match.useProfile}</button></div>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>{m.match.needBirth} <Link href="/chart/edit">{m.match.addBirth}</Link>.</p>
            )}
            <PersonFields id="a" draft={a} onChange={setA} />
          </>
        )}
      </section>

      <section className="panel stack gap-12" aria-labelledby="match-them">
        <h2 className="h3" id="match-them">{m.match.them}</h2>
        <PersonFields id="b" draft={b} onChange={setB} withName />
        <p className="muted small" style={{ margin: 0 }}>{m.match.consent}</p>
      </section>

      {error && <p className="field-error" style={{ margin: 0 }}>{m.match.invalid}</p>}
      <div><button type="button" className="btn btn-primary" onClick={compare}>{m.match.compare}</button></div>

      <section className="stack gap-12" aria-labelledby="match-saved">
        <h2 className="h2" id="match-saved">{m.match.saved}</h2>
        <MatchList matches={matches} onDeleted={() => setMatches(listMatches())} />
      </section>
    </div>
  );
}
