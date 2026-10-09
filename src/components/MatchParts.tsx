"use client";
// Shared Match UI: one line per factor (its basis), and the saved-matches list.
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { deleteMatch, type SavedMatch } from "@/lib/store";
import type { Factor, MatchBody } from "@/lib/astro/match";
import { PLANET_NAME, SIGN_INFO } from "@/lib/astro/zodiac";
import { ELEMENT_NAME } from "@/lib/astro/labels";
import { getEntry, learnHref } from "@/lib/learn";
import { formatLocalDate, localDateKey } from "@/lib/time";

const GLYPH = { conjunction: "☌", sextile: "⚹", square: "□", trine: "△", opposition: "☍" } as const;

export function FactorLine({ f, name }: { f: Factor; name: string }) {
  const { m, fmt, pick } = useI18n();
  const body = (b: MatchBody) => (b === "asc" ? m.chart.rising : pick(PLANET_NAME[b]));
  const a = fmt(m.match.yourBody, { body: body(f.a) });
  const b = fmt(m.match.theirBody, { name, body: body(f.b) });
  if (f.kind === "aspect" && f.aspect) {
    const title = pick(getEntry("aspect", f.aspect)!.title);
    return (
      <li className="small">
        {fmt(m.match.aspect, { a, glyph: GLYPH[f.aspect], b, aspect: title, orb: (f.orb ?? 0).toFixed(1) })}{" "}
        <Link href={learnHref("aspect", f.aspect)} aria-label={title}>↗</Link>
      </li>
    );
  }
  if (f.kind === "element" && f.signs[0] && f.signs[1]) {
    const [sa, sb] = [SIGN_INFO[f.signs[0]], SIGN_INFO[f.signs[1]]];
    return (
      <li className="small">
        {fmt(m.match.element, {
          a, b,
          signA: pick(sa.name), elA: pick(ELEMENT_NAME[sa.element]),
          signB: pick(sb.name), elB: pick(ELEMENT_NAME[sb.element]),
          relation: m.match.relation[f.relation!],
        })}
      </li>
    );
  }
  return <li className="small muted">{fmt(m.match.uncertain, { a, b })}</li>;
}

export function MatchList({ matches, onDeleted }: { matches: SavedMatch[]; onDeleted?: () => void }) {
  const { m, fmt, locale } = useI18n();
  if (!matches.length) return <p className="muted" style={{ margin: 0 }}>{m.match.none}</p>;
  return (
    <ul className="list">
      {matches.map((x) => (
        <li key={x.id}>
          <Link href={`/match/r/${x.id}`} style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontWeight: 500 }}>{fmt(m.match.resultTitle, { name: x.b.name || m.match.defaultName })}</span>
            <span className="muted small">
              {formatLocalDate(localDateKey(new Date(x.createdAt)), locale)}
              {x.result.score !== null ? ` · ${m.match.score} ${x.result.score}` : ""}
            </span>
          </Link>
          <button
            type="button"
            className="btn-text"
            onClick={() => {
              if (!window.confirm(m.match.confirmDelete)) return;
              deleteMatch(x.id);
              onDeleted?.();
            }}
          >
            {m.match.delete}
          </button>
        </li>
      ))}
    </ul>
  );
}
