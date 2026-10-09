"use client";
// Learn detail page for a sign, planet, house, aspect, tarot card or spread. "In your chart" is
// computed in the browser from saved birth details; nothing is sent anywhere.
// Functional build; visual design pending.
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useRouteSegment } from "@/lib/shell";
import { getBirth, getSettings, isFavorite, toggleFavorite, useStoreVersion } from "@/lib/store";
import {
  ASPECT_CONTENT, HOUSE_CONTENT, PLANET_CONTENT, RULES, SIGN_CONTENT, SPREAD_CONTENT, SUIT_NAME, TRADITIONAL_RULER,
  getEntry, isLearnType, learnHref,
} from "@/lib/learn";
import { computeChart, type NatalChart } from "@/lib/astro/chart";
import { PLANETS, PLANET_NAME, SIGNS, SIGN_INFO, type Planet, type Sign } from "@/lib/astro/zodiac";
import { ELEMENT_NAME, MODALITY_NAME, houseName } from "@/lib/astro/labels";
import { HOUSE_THEME } from "@/lib/astro/horoscope";
import { NATAL_RULES } from "@/lib/astro/natal-facts";
import { ASPECT_MEANING, PLANET_FUNCTION, SIGN_KEYWORDS } from "@/lib/astro/natal-text";
import { DECK, elementOf, getCard } from "@/lib/tarot/deck";
import { SPREADS } from "@/lib/tarot/spreads";
import type { CardSide, L10n } from "@/lib/tarot/types";
import { TarotCard } from "@/components/TarotCard";
import { EntryIcon } from "@/components/AstroIcon";

function useChart(): NatalChart | null | undefined {
  const version = useStoreVersion();
  const [chart, setChart] = useState<NatalChart | null | undefined>(undefined);
  useEffect(() => {
    const birth = getBirth();
    try {
      setChart(birth ? computeChart(birth, getSettings().houseSystem) : null);
    } catch {
      setChart(null);
    }
  }, [version]);
  return chart;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="stack gap-4">
      <span className="meta">{label}</span>
      <div>{children}</div>
    </div>
  );
}

function SaveButton({ type, slug }: { type: string; slug: string }) {
  const { m } = useI18n();
  const version = useStoreVersion();
  const [on, setOn] = useState(false);
  useEffect(() => setOn(isFavorite(type, slug)), [type, slug, version]);
  return (
    <button type="button" className="chip" aria-pressed={on} onClick={() => setOn(toggleFavorite(type, slug))}>
      {on ? `★ ${m.learn.saved}` : `☆ ${m.learn.save}`}
    </button>
  );
}

const signLink = (s: Sign, pick: (l: L10n) => string) => <Link href={learnHref("sign", s)}>{pick(SIGN_INFO[s].name)}</Link>;
const planetLink = (p: Planet, pick: (l: L10n) => string) => <Link href={learnHref("planet", p)}>{pick(PLANET_NAME[p])}</Link>;

function YourChart({ children }: { children: (chart: NatalChart) => React.ReactNode }) {
  const { m } = useI18n();
  const chart = useChart();
  if (chart === undefined) return null;
  return (
    <section className="panel stack gap-8">
      <span className="meta">{m.learn.inYourChart}</span>
      {chart ? children(chart) : <p className="muted small" style={{ margin: 0 }}><Link href="/chart/edit">{m.learn.addBirth}</Link></p>}
    </section>
  );
}

function Side({ title, side }: { title: string; side: CardSide }) {
  const { m, pick, locale } = useI18n();
  return (
    <section className="stack gap-8">
      <h2 className="h2">{title}</h2>
      <div className="kw">{side.keywords[locale].map((k) => <span key={k}>{k}</span>)}</div>
      <p style={{ margin: 0 }}>{pick(side.meaning)}</p>
      <p className="muted" style={{ margin: 0 }}><strong style={{ color: "var(--text-1)", fontWeight: 500 }}>{m.learn.love}: </strong>{pick(side.love)}</p>
      <p className="muted" style={{ margin: 0 }}><strong style={{ color: "var(--text-1)", fontWeight: 500 }}>{m.learn.work}: </strong>{pick(side.work)}</p>
      <p className="muted" style={{ margin: 0 }}><strong style={{ color: "var(--text-1)", fontWeight: 500 }}>{m.topics.growth}: </strong>{pick(side.growth)}</p>
      <p className="quote" style={{ margin: 0 }}>{pick(side.advice)}</p>
    </section>
  );
}

export default function LearnDetail() {
  const raw = useParams<{ type: string; slug: string }>();
  const type = useRouteSegment(raw.type, 1); // null until known on the offline shell
  const slug = useRouteSegment(raw.slug, 2);
  const { m, fmt, pick, locale } = useI18n();
  const list = (items: string[]) => items.join(locale === "zh" ? "、" : ", ");
  const entry = useMemo(() => (type && slug && isLearnType(type) ? getEntry(type, decodeURIComponent(slug)) : null), [type, slug]);

  if (type === null || slug === null) return null;

  if (!entry) {
    return (
      <div className="stack gap-16">
        <h1 className="h1">{m.learn.notFound}</h1>
        <div><Link href="/learn" className="btn btn-ghost">{m.learn.backToLearn}</Link></div>
      </div>
    );
  }

  const header = (
    <header className="stack gap-8">
      <Link href="/learn" className="meta">← {m.learn.backToLearn}</Link>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <h1 className="h1" style={{ display: "inline-flex", alignItems: "center", gap: 14 }}><EntryIcon entry={entry} size={40} />{pick(entry.title)}</h1>
        <SaveButton type={entry.type} slug={entry.slug} />
      </div>
      <p className="lede" style={{ margin: 0 }}>{pick(entry.subtitle)}</p>
    </header>
  );

  let body: React.ReactNode = null;
  switch (entry.type) {
    case "sign": {
      const s = entry.slug as Sign;
      const c = SIGN_CONTENT.find((x) => x.id === s)!;
      const info = SIGN_INFO[s];
      const ruler = NATAL_RULES.rulers[s];
      const trad = TRADITIONAL_RULER[s];
      const siblings = SIGNS.filter((x) => x !== s && SIGN_INFO[x].element === info.element);
      body = (
        <>
          <p style={{ margin: 0 }}>{pick(c.summary)}</p>
          <div className="grid-tiles">
            <Row label={m.learn.keywords}>{pick(SIGN_KEYWORDS[s])}</Row>
            <Row label={m.learn.strengths}>{pick(c.strengths)}</Row>
            <Row label={m.learn.growth}>{pick(c.growth)}</Row>
            <Row label={m.learn.ruler}>{planetLink(ruler, pick)}{trad && <span className="muted">{locale === "zh" ? "（" : " ("}{fmt(m.learn.traditionalRuler, { planet: pick(PLANET_NAME[trad]) })}{locale === "zh" ? "）" : ")"}</span>}</Row>
            <Row label={m.learn.element}>{pick(ELEMENT_NAME[info.element])}</Row>
            <Row label={m.learn.modality}>{pick(MODALITY_NAME[info.modality])}</Row>
          </div>
          <Row label={fmt(m.learn.sameElement, { element: pick(ELEMENT_NAME[info.element]) })}>
            {siblings.map((x, i) => <span key={x}>{i > 0 && " · "}{signLink(x, pick)}</span>)}
          </Row>
          <YourChart>
            {(chart) => {
              const here = [
                ...PLANETS.filter((p) => chart.positions[p].placement.sign === s).map((p) => pick(PLANET_NAME[p])),
                ...(chart.asc?.sign === s ? [m.chart.rising] : []),
              ];
              return <p style={{ margin: 0 }}>{here.length ? fmt(m.learn.yourPlacementsHere, { list: list(here) }) : m.learn.noPlacementsHere}</p>;
            }}
          </YourChart>
        </>
      );
      break;
    }
    case "planet": {
      const p = entry.slug as Planet;
      const c = PLANET_CONTENT.find((x) => x.id === p)!;
      body = (
        <>
          <p style={{ margin: 0 }}>{pick(c.summary)}</p>
          <div className="grid-tiles">
            <Row label={m.learn.function}>{pick(PLANET_FUNCTION[p])}</Row>
            <Row label={m.learn.pace}>{pick(c.pace)}</Row>
            <Row label={m.learn.rules}>{RULES[p].length ? RULES[p].map((s, i) => <span key={s}>{i > 0 && " · "}{signLink(s, pick)}</span>) : <span className="muted small">{m.learn.rulesNone}</span>}</Row>
          </div>
          <YourChart>
            {(chart) => {
              const big = p === "sun" || p === "moon" ? chart.bigThree[p] : null;
              if (big?.options) return <p style={{ margin: 0 }}>{fmt(m.learn.yourPlanetUncertain, { planet: pick(PLANET_NAME[p]), a: pick(SIGN_INFO[big.options[0]].name), b: pick(SIGN_INFO[big.options[1]].name) })}</p>;
              const pos = chart.positions[p];
              return (
                <p style={{ margin: 0 }}>
                  {fmt(m.learn.yourPlanet, {
                    planet: pick(PLANET_NAME[p]),
                    sign: pick(SIGN_INFO[pos.placement.sign].name),
                    house: pos.house ? fmt(m.learn.yourPlanetHouse, { house: pick(houseName(pos.house)) }) : "",
                  })}{" "}
                  <Link href={learnHref("sign", pos.placement.sign)}>{pick(SIGN_INFO[pos.placement.sign].name)} →</Link>
                </p>
              );
            }}
          </YourChart>
        </>
      );
      break;
    }
    case "house": {
      const n = Number(entry.slug);
      const c = HOUSE_CONTENT.find((x) => x.id === n)!;
      const kind = [1, 4, 7, 10].includes(n) ? "angular" : [2, 5, 8, 11].includes(n) ? "succedent" : "cadent";
      body = (
        <>
          <p style={{ margin: 0 }}>{pick(c.summary)}</p>
          <div className="grid-tiles">
            <Row label={m.learn.theme}>{pick(HOUSE_THEME[n - 1])}</Row>
            <Row label={m.learn.naturalSign}>{signLink(SIGNS[n - 1], pick)}</Row>
            <Row label={m.learn.houseKind[kind]}>{n > 1 && <Link href={learnHref("house", n - 1)}>← {pick(houseName(n - 1))}</Link>} {n < 12 && <Link href={learnHref("house", n + 1)}>{pick(houseName(n + 1))} →</Link>}</Row>
          </div>
          <YourChart>
            {(chart) => {
              if (!chart.timeKnown) return <p className="muted small" style={{ margin: 0 }}>{m.learn.houseNeedsTime}</p>;
              const here = PLANETS.filter((p) => chart.positions[p].house === n);
              return (
                <p style={{ margin: 0 }}>
                  {here.length
                    ? fmt(m.learn.planetsInHouse, { house: pick(houseName(n)), list: list(here.map((p) => pick(PLANET_NAME[p]))) })
                    : fmt(m.learn.noPlanetsInHouse, { house: pick(houseName(n)) })}
                </p>
              );
            }}
          </YourChart>
        </>
      );
      break;
    }
    case "aspect": {
      const c = ASPECT_CONTENT.find((x) => x.id === entry.slug)!;
      const orb = NATAL_RULES.orbs[c.id];
      body = (
        <>
          <p style={{ margin: 0 }}>{pick(c.summary)}</p>
          <div className="grid-tiles">
            <Row label={m.learn.angle}>{c.angle}°</Row>
            <Row label={m.learn.theme}>{pick(ASPECT_MEANING[c.id])}</Row>
          </div>
          <p className="muted small" style={{ margin: 0 }}>{fmt(m.learn.orbRule, { orb, lum: orb + NATAL_RULES.luminaryBonus })}</p>
        </>
      );
      break;
    }
    case "card": {
      const card = getCard(entry.slug);
      const i = DECK.findIndex((x) => x.id === card.id);
      const prev = DECK[(i + DECK.length - 1) % DECK.length], next = DECK[(i + 1) % DECK.length];
      const el = elementOf(card);
      body = (
        <>
          <div className="card-block">
            <TarotCard id={card.id} reversed={false} revealed label={pick(card.name)} />
            <div className="stack gap-8">
              <Row label={m.learn.arcana}>{card.suit ? `${pick(SUIT_NAME[card.suit])}${el ? ` · ${pick(ELEMENT_NAME[el])}` : ""}` : pick(entry.subtitle)}</Row>
              <Row label={m.learn.onTheCard}>{pick(card.description)}</Row>
            </div>
          </div>
          <Side title={m.learn.upright} side={card.upright} />
          <Side title={m.learn.reversed} side={card.reversed} />
          <div className="btn-row">
            <Link href={learnHref("card", prev.id)} className="btn-text">← {pick(prev.name)}</Link>
            <Link href={learnHref("card", next.id)} className="btn-text">{pick(next.name)} →</Link>
          </div>
          <p className="muted small" style={{ margin: 0 }}>{m.learn.cardCredit}</p>
        </>
      );
      break;
    }
    case "spread": {
      const c = SPREAD_CONTENT.find((x) => x.id === entry.slug)!;
      const s = SPREADS[c.id];
      body = (
        <>
          <p style={{ margin: 0 }}>{m.spreads[c.id].desc}</p>
          <Row label={m.learn.positions}>
            <ol style={{ margin: 0, paddingLeft: 20 }}>{s.positions.map((p, i) => <li key={i}>{pick(p)}</li>)}</ol>
          </Row>
          <Row label={m.learn.howTo}>{pick(c.howTo)}</Row>
          <div><Link href={`/tarot/new?spread=${c.id}`} className="btn btn-primary">{m.learn.useSpread}</Link></div>
        </>
      );
      break;
    }
  }

  return (
    <div className="stack gap-24" style={{ maxWidth: 760 }}>
      {header}
      {body}
    </div>
  );
}
