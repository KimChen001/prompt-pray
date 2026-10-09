// Natal report versions (combined review, "本命报告保存与版本一致性").
// A saved report is valid only for the exact chart facts and rule/prompt versions it was written
// from. Each saved version is self-contained (titles, evidence labels, limitations, text), so older
// versions stay readable after the birth details or the rules change.
import type { AiMeta, L10n, Locale } from "@/lib/tarot/types";
import type { HouseSystem } from "./houses";
import type { NatalFacts } from "./natal-facts";
import type { ThemeSelection } from "./natal-themes";
import { factLabel, NATAL_TEXT_VERSION } from "./natal-text";

export const NATAL_REPORT_TYPE = "natal-core";

/** FNV-1a (32-bit) over the facts' content: changes whenever any fact id or value changes. */
export function chartFingerprint(nf: NatalFacts): string {
  const s = JSON.stringify(nf.facts);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface NatalVersionKey {
  fingerprint: string;
  timeKnown: boolean;
  houseSystem: HouseSystem;
  factsVersion: string;
  themesVersion: string;
  textVersion: string;
  promptVersion: string;
  locale: Locale;
  reportType: string;
  previousFingerprints?: string[];
}

export function natalVersionKey(nf: NatalFacts, sel: ThemeSelection, houseSystem: HouseSystem, promptVersion: string, locale: Locale): NatalVersionKey {
  return {
    fingerprint: chartFingerprint(nf),
    timeKnown: nf.timeKnown,
    // Houses only exist with a birth time; without one the house system cannot change the report.
    houseSystem: nf.timeKnown ? houseSystem : "placidus",
    factsVersion: nf.version,
    themesVersion: sel.version,
    textVersion: NATAL_TEXT_VERSION,
    promptVersion,
    locale,
    reportType: NATAL_REPORT_TYPE,
    ...(nf.legacyFacts ? { previousFingerprints: [chartFingerprint({ ...nf, facts: nf.legacyFacts })] } : {}),
  };
}

export const keyString = (k: NatalVersionKey) =>
  [k.reportType, k.fingerprint, k.timeKnown ? "t" : "n", k.houseSystem, k.factsVersion, k.themesVersion, k.textVersion, k.promptVersion, k.locale].join("|");

/** Same chart and language, any rule/prompt version. */
export const sameChart = (a: NatalVersionKey, b: NatalVersionKey) =>
  a.reportType === b.reportType && (a.fingerprint === b.fingerprint || a.previousFingerprints?.includes(b.fingerprint) || b.previousFingerprints?.includes(a.fingerprint)) === true && a.timeKnown === b.timeKnown && a.houseSystem === b.houseSystem && a.locale === b.locale;

export interface SavedNatalTheme {
  id: string;
  title: L10n;
  text: string;
  /** The facts the text cites, with their labels frozen at generation time. */
  evidence: { id: string; label: L10n }[];
  limitations: L10n[];
}

export interface SavedNatalReport {
  key: NatalVersionKey;
  createdAt: string; // ISO instant
  themes: SavedNatalTheme[];
  overview: string;
  meta: AiMeta;
}

/** Facts sent to the AI even when no theme cites them, so every sign/Rising claim can be checked. */
const REFERENCE_KINDS = new Set(["placement", "uncertainPlacement", "angle"]);

/**
 * The request body for /api/ai/natal: the facts the selected themes cite, plus every placement and
 * angle (signs, houses, degrees) for claim checking. No birth date, time or place.
 */
export function natalRequestBody(nf: NatalFacts, sel: ThemeSelection, locale: Locale) {
  const cited = new Set(sel.themes.flatMap((t) => t.evidenceIds));
  return {
    locale,
    timeKnown: nf.timeKnown,
    factsVersion: nf.version,
    themesVersion: sel.version,
    facts: nf.facts.filter((f) => cited.has(f.id) || REFERENCE_KINDS.has(f.kind)),
    themes: sel.themes.map((t) => ({ id: t.id, kind: t.kind, title: t.title, evidenceIds: t.evidenceIds, limitations: t.limitations })),
  };
}

export interface NatalAiResponse {
  themes: { id: string; text: string; evidenceIds: string[] }[];
  overview: string;
  promptVersion: string;
  meta: AiMeta;
}

/** Freezes an AI response into a self-contained saved version. */
export function toSavedReport(key: NatalVersionKey, nf: NatalFacts, sel: ThemeSelection, res: NatalAiResponse): SavedNatalReport {
  return {
    key,
    createdAt: res.meta.generatedAt,
    overview: res.overview,
    meta: res.meta,
    themes: res.themes.map((t) => {
      const theme = sel.themes.find((s) => s.id === t.id)!;
      return {
        id: t.id,
        title: theme.title,
        text: t.text,
        evidence: t.evidenceIds.map((id) => ({ id, label: factLabel(nf.byId.get(id)!) })),
        limitations: theme.limitations,
      };
    }),
  };
}
