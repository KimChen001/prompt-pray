// First-pass crisis detection for free-text input (plan v0.2 §4.3).
// This keyword layer errs on the side of showing support. An AI classifier is added on 10/13;
// keywords stay as the fallback when the AI is unavailable.

const PATTERNS: RegExp[] = [
  /\bsuicid(e|al)\b/i,
  /\bkill(ing)?\s+my\s*self\b/i,
  /\bend(ing)?\s+(my\s+life|it\s+all)\b/i,
  /\btake\s+my\s+(own\s+)?life\b/i,
  /\bwant(s|ing)?\s+to\s+die\b/i,
  /\b(don'?t|do\s+not)\s+want\s+to\s+(live|be\s+alive|exist|wake\s+up)\b/i,
  /\bno\s+reason\s+to\s+live\b/i,
  /\bself[-\s]?harm/i,
  /\b(hurt|cut|harm)(ing)?\s+my\s*self\b/i,
  /\boverdos(e|ing)\b/i,
  /自杀|自殺|轻生|輕生|自残|自殘|割腕|想死|不想活|活不下去|结束(我的)?生命|結束生命|了结自己|寻死|尋死/,
];

export function detectCrisis(text: string): boolean {
  const t = text.normalize("NFKC");
  return PATTERNS.some((p) => p.test(t));
}

export type HelpRegion = "US" | "other";

const US_ZONES = /^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Nome|Adak|Boise|Detroit|Menominee|Metlakatla|Yakutat|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+)|Pacific\/Honolulu|US\/.+)$/;

/** Guess from the device time zone (not from the UI language). Users can override in settings. */
export function guessHelpRegion(timeZone: string): HelpRegion {
  return US_ZONES.test(timeZone) ? "US" : "other";
}
