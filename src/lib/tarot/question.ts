/** Same question, ignoring case, spacing and punctuation. */
export function normalizeQuestion(q: string): string {
  return q.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}
