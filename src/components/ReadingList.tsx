"use client";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { cardImage } from "@/lib/tarot/deck";
import { formatLocalDate } from "@/lib/time";
import type { Reading } from "@/lib/tarot/types";

export function ReadingList({ readings, onDelete }: { readings: Reading[]; onDelete?: (id: string) => void }) {
  const { m, locale } = useI18n();
  return (
    <ul className="list">
      {readings.map((r) => {
        const href = r.kind === "daily" ? "/today" : `/tarot/r/${r.id}`;
        const title = r.kind === "daily" ? m.daily.title : m.spreads[r.spread].name;
        return (
          <li key={r.id}>
            <span className="mini-cards" aria-hidden="true">
              {r.cards.map((c, i) => <img key={i} src={cardImage(c.id)} alt="" data-reversed={c.reversed} loading="lazy" />)}
            </span>
            <Link href={href} style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontWeight: 500 }}>{title}</span>
              <span className="muted small" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {formatLocalDate(r.localDate, locale)}{r.question ? ` · ${r.question}` : ""}
              </span>
            </Link>
            {onDelete && (
              <button type="button" className="btn-text" onClick={() => onDelete(r.id)}>{m.common.delete}</button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
