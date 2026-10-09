// What goes on a share image (plan v0.2 §3.9, decision #4): by default no question text and no
// birth data. A reading shows its cards and one-line phrases; the chart shows only the Big Three
// sign names; a match shows the score and labels, with the other person's nickname only if asked.
// Pure functions: the canvas renderer draws exactly these strings.
import type { Messages } from "@/lib/i18n/en";
import type { L10n, Locale, Reading, TarotAiResult } from "@/lib/tarot/types";
import type { Analysis } from "@/lib/tarot/engine";
import type { NatalChart, SignCandidate } from "@/lib/astro/chart";
import { SIGN_INFO } from "@/lib/astro/zodiac";
import type { SavedMatch } from "@/lib/store";
import { formatLocalDate } from "@/lib/time";

export interface ShareCard {
  eyebrow: string;
  title: string;
  subtitle?: string;
  quote?: string;
  cards?: { id: string; reversed: boolean; name: string; line: string }[];
  rows?: { label: string; value: string }[];
  big?: string;
  bigLabel?: string;
  note?: string;
  footer: string;
}

const pick = (l: L10n, locale: Locale) => l[locale];

export function readingCard(r: Reading, a: Analysis, ai: TarotAiResult | undefined, m: Messages, locale: Locale, opts: { includeQuestion: boolean }): ShareCard {
  return {
    eyebrow: `MOONA · ${m.nav.tarot}`,
    title: m.spreads[r.spread].name,
    subtitle: formatLocalDate(r.localDate, locale),
    quote: opts.includeQuestion && r.question ? r.question : undefined,
    cards: a.perCard.map((c) => ({ id: c.id, reversed: c.reversed, name: `${pick(c.position, locale)} · ${pick(c.name, locale)}${c.reversed ? ` (${m.common.reversed})` : ""}`, line: pick(c.phrase, locale) })),
    note: ai ? ai.action : pick(a.action, locale),
    footer: m.disclaimer,
  };
}

/**
 * The text version of a reading, with the same defaults as the image: the question appears only when
 * the person ticks "Include my question". Birth details are never part of it.
 */
export function readingShareText(r: Reading, a: Analysis, ai: TarotAiResult | undefined, m: Messages, locale: Locale, opts: { includeQuestion: boolean }): string {
  const lines = [`${m.reading.shareText} · ${m.spreads[r.spread].name} · ${formatLocalDate(r.localDate, locale)}`];
  if (opts.includeQuestion && r.question) lines.push(`${m.reading.yourQuestion}: ${r.question}`);
  lines.push("");
  a.perCard.forEach((c, i) => {
    lines.push(`【${pick(c.position, locale)}】${pick(c.name, locale)}${c.reversed ? ` (${m.common.reversed})` : ""}`);
    lines.push(ai ? ai.cards[i].insight : pick(c.meaning, locale));
    lines.push("");
  });
  lines.push(`${m.reading.synthesis}: ${ai ? ai.synthesis : pick(a.summary, locale)}`);
  lines.push(`${m.reading.action}: ${ai ? ai.action : pick(a.action, locale)}`);
  lines.push(`${m.reading.reflection}: ${ai ? ai.reflection : pick(a.reflection, locale)}`);
  lines.push("", ai ? `(AI · ${ai.meta.model})` : `(${m.badge.offline})`, m.disclaimer);
  return lines.join("\n");
}

export function dailyCard(localDate: string, cardId: string, reversed: boolean, name: string, line: string, m: Messages, locale: Locale): ShareCard {
  return {
    eyebrow: `MOONA · ${m.daily.title}`,
    title: name,
    subtitle: formatLocalDate(localDate, locale),
    cards: [{ id: cardId, reversed, name: reversed ? `${name} (${m.common.reversed})` : name, line }],
    footer: m.disclaimer,
  };
}

/** Only the three sign names — never the birth date, time or place. */
export function bigThreeCard(chart: NatalChart, m: Messages, locale: Locale): ShareCard {
  const show = (c: SignCandidate | null) =>
    !c ? "?" : c.placement ? pick(SIGN_INFO[c.placement.sign].name, locale) : c.options ? c.options.map((s) => pick(SIGN_INFO[s].name, locale)).join(" / ") : "?";
  return {
    eyebrow: `MOONA · ${m.chart.title}`,
    title: m.chart.bigThree,
    rows: [
      { label: m.chart.sun, value: show(chart.bigThree.sun) },
      { label: m.chart.moon, value: show(chart.bigThree.moon) },
      { label: m.chart.rising, value: show(chart.bigThree.rising) },
    ],
    footer: m.disclaimer,
  };
}

/** Score and labels only; the other person's nickname is included only on request. */
export function matchCard(x: SavedMatch, m: Messages, opts: { includeName: boolean }): ShareCard {
  const name = opts.includeName && x.b.name ? x.b.name : m.match.defaultName;
  return {
    eyebrow: `MOONA · ${m.match.title}`,
    title: m.match.resultTitle.replace("{name}", name),
    big: x.result.score !== null ? String(x.result.score) : undefined,
    bigLabel: m.match.score,
    rows: (["emotional", "communication", "attraction"] as const).map((d) => ({ label: m.match.dims[d], value: m.match.labels[x.result.labels[d]] })),
    footer: m.match.disclaimer,
  };
}
