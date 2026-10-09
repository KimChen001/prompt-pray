// Downloads the 78 Rider–Waite–Smith 1909 card scans from Wikimedia Commons
// into public/cards/ and records provenance in content/credits.json.
// Usage: node scripts/fetch-cards.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const UA = "MOONA-hackathon/0.1 (https://github.com/KimChen001/prompt-pray)";
const API = "https://commons.wikimedia.org/w/api.php";
const WIDTH = 500;
const OUT = join(process.cwd(), "public", "cards");

const MAJORS = [
  "Fool", "Magician", "High Priestess", "Empress", "Emperor", "Hierophant", "Lovers",
  "Chariot", "Strength", "Hermit", "Wheel of Fortune", "Justice", "Hanged Man", "Death",
  "Temperance", "Devil", "Tower", "Star", "Moon", "Sun", "Judgement", "World",
];
const SUITS = { wands: "Wands", cups: "Cups", swords: "Swords", pentacles: "Pentacles" };
const pad = (n) => String(n).padStart(2, "0");

const cards = [
  ...MAJORS.map((name, i) => ({ id: `major-${pad(i)}`, title: `File:RWS1909 - ${pad(i)} ${name}.jpeg` })),
  ...Object.entries(SUITS).flatMap(([suit, label]) =>
    Array.from({ length: 14 }, (_, i) => ({ id: `${suit}-${pad(i + 1)}`, title: `File:RWS1909 - ${label} ${pad(i + 1)}.jpeg` })),
  ),
];

const strip = (html = "") => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

async function imageInfo(titles) {
  const url = new URL(API);
  url.search = new URLSearchParams({
    action: "query", format: "json", formatversion: "2", prop: "imageinfo",
    iiprop: "url|extmetadata", iiurlwidth: String(WIDTH), titles: titles.join("|"),
  });
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Commons API ${res.status}`);
  const data = await res.json();
  return Object.fromEntries(data.query.pages.map((p) => [p.title, p]));
}

await mkdir(OUT, { recursive: true });
const credits = [];
for (let i = 0; i < cards.length; i += 40) {
  const batch = cards.slice(i, i + 40);
  const pages = await imageInfo(batch.map((c) => c.title));
  for (const card of batch) {
    const page = pages[card.title];
    const info = page?.imageinfo?.[0];
    if (!info) throw new Error(`Missing on Commons: ${card.title}`);
    const meta = info.extmetadata ?? {};
    const license = strip(meta.LicenseShortName?.value);
    if (!/public domain/i.test(license)) throw new Error(`${card.title} is not public domain: ${license}`);
    const res = await fetch(info.thumburl, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`Download failed ${res.status}: ${card.title}`);
    await writeFile(join(OUT, `${card.id}.jpg`), Buffer.from(await res.arrayBuffer()));
    credits.push({
      id: card.id,
      file: `public/cards/${card.id}.jpg`,
      source: info.descriptionurl,
      license,
      artist: strip(meta.Artist?.value) || "Pamela Colman Smith",
    });
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 150));
  }
}

credits.push({
  id: "back",
  file: "public/cards/back.jpg",
  source: "Carried over from the MOONA WeChat mini-program; original source not yet documented",
  license: "UNVERIFIED — pending team decision on the card back",
  artist: "Unknown",
});

await writeFile(join(process.cwd(), "content", "credits.json"), JSON.stringify(credits, null, 2) + "\n");
console.log(`\nSaved ${cards.length} cards to public/cards and content/credits.json`);
