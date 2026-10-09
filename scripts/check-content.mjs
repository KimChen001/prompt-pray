// Fails (exit 1) if any tarot card is missing a field, a language, an image or a credit.
// Usage: node scripts/check-content.mjs
import { readFileSync, existsSync } from "node:fs";

const FILES = ["major-a", "major-b", "wands", "cups", "swords", "pentacles"];
const SIDE_FIELDS = ["meaning", "advice", "love", "work", "growth"];
const LANGS = ["en", "zh"];
const errors = [];
const err = (id, msg) => errors.push(`${id}: ${msg}`);

const cards = FILES.flatMap((f) => JSON.parse(readFileSync(`content/tarot/${f}.json`, "utf8")));
const credits = JSON.parse(readFileSync("content/credits.json", "utf8"));
const credited = new Set(credits.map((c) => c.id));

const expected = [
  ...Array.from({ length: 22 }, (_, i) => `major-${String(i).padStart(2, "0")}`),
  ...["wands", "cups", "swords", "pentacles"].flatMap((s) => Array.from({ length: 14 }, (_, i) => `${s}-${String(i + 1).padStart(2, "0")}`)),
];
const ids = cards.map((c) => c.id);
expected.filter((id) => !ids.includes(id)).forEach((id) => err(id, "missing card"));
ids.filter((id, i) => ids.indexOf(id) !== i).forEach((id) => err(id, "duplicate id"));

const text = (id, path, v) => LANGS.forEach((l) => (typeof v?.[l] === "string" && v[l].trim() ? null : err(id, `${path}.${l} empty`)));

for (const c of cards) {
  text(c.id, "name", c.name);
  text(c.id, "description", c.description);
  for (const side of ["upright", "reversed"]) {
    const s = c[side];
    if (!s) { err(c.id, `${side} missing`); continue; }
    SIDE_FIELDS.forEach((f) => text(c.id, `${side}.${f}`, s[f]));
    LANGS.forEach((l) => (s.keywords?.[l]?.length === 4 ? null : err(c.id, `${side}.keywords.${l} must have 4 items`)));
    LANGS.filter((l) => l === "zh").forEach(() => {
      SIDE_FIELDS.forEach((f) => /[A-Za-z]{3,}/.test(s[f]?.zh ?? "") && err(c.id, `${side}.${f}.zh contains English`));
    });
  }
  if (!existsSync(`public/cards/${c.id}.jpg`)) err(c.id, "image missing");
  if (!credited.has(c.id)) err(c.id, "no entry in content/credits.json");
}
if (!existsSync("public/cards/back.jpg")) err("back", "image missing");

if (errors.length) {
  console.error(`Content check failed (${errors.length}):\n  ` + errors.join("\n  "));
  process.exit(1);
}
console.log(`Content OK: ${cards.length} cards × 2 sides × ${LANGS.length} languages, images and credits present.`);
