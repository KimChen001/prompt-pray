"use client";
// The mono data line under page titles: "AUG 14, 1999 · 07:30 EDT · BOSTON" (Figma page headers).
import { useI18n } from "@/lib/i18n";
import { formatOffset, zoneAbbreviation, type BirthData } from "@/lib/astro/birth";
import type { NatalChart } from "@/lib/astro/chart";
import { formatLocalDate } from "@/lib/time";

export function BirthMetaLine({ birth, chart }: { birth: BirthData; chart: NatalChart }) {
  const { locale } = useI18n();
  const r = chart.resolved;
  const zone = r ? zoneAbbreviation(r.utc, birth.place.tz) ?? formatOffset(r.offset) : null;
  const place = locale === "zh" && birth.place.zh ? birth.place.zh : birth.place.name;
  return (
    <p className="page-head-line">
      <span>{formatLocalDate(birth.date, locale)}</span>
      {birth.time && <span>{birth.time}{zone ? ` ${zone}` : ""}</span>}
      <span>{place}</span>
    </p>
  );
}
