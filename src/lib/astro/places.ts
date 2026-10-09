// Birthplace search over GeoNames cities5000 (server-side only; data/places.json is ~5 MB).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BirthPlace } from "./birth";

type Row = [name: string, ascii: string, admin1: string, country: string, lat: number, lon: number, tz: number, population: number, zh: string];
interface PlacesFile { zones: string[]; places: Row[] }

export interface PlaceResult extends BirthPlace {
  population: number;
}

let cache: { zones: string[]; rows: Row[]; keys: string[] } | null = null;
function load() {
  if (!cache) {
    const data = JSON.parse(readFileSync(join(process.cwd(), "data", "places.json"), "utf8")) as PlacesFile;
    cache = { zones: data.zones, rows: data.places, keys: data.places.map((r) => normalize(r[1])) };
  }
  return cache;
}

export function normalize(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const US_STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware",
  dc: "washington dc", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas",
  ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi",
  mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york",
  nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island",
  sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington",
  wv: "west virginia", wi: "wisconsin", wy: "wyoming",
};

const CJK = /[\u3400-\u9fff]/;
// Traditional-only characters common in place names; used to prefer the Simplified alias.
const TRADITIONAL = /[頓爾蘭維華灣東島國門馬龍鳳廣慶齊聖薩羅亞橋盧蘇倫紐約費聯奧達歐愛臺將與麗陽陰錫萊頭貝濟賓殼鄉樂納]/g;
function simplifiedFirst(aliases: string): string | null {
  if (!aliases) return null;
  const list = aliases.split("|");
  return list.reduce((best, a) => ((a.match(TRADITIONAL)?.length ?? 0) < (best.match(TRADITIONAL)?.length ?? 0) ? a : best), list[0]);
}

/** "boston", "Cambridge, MA", "cambridge massachusetts", "波士顿" */
export function searchPlaces(query: string, limit = 8): PlaceResult[] {
  const { zones, rows, keys } = load();
  const raw = query.trim().slice(0, 80);
  if (!raw) return [];

  const toResult = (r: Row): PlaceResult => ({
    name: r[0], admin1: r[2] || undefined, country: r[3], lat: r[4], lon: r[5], tz: zones[r[6]], population: r[7], zh: simplifiedFirst(r[8]),
  });

  if (CJK.test(raw)) {
    return rows.filter((r) => r[8] && r[8].split("|").some((z) => z.includes(raw))).slice(0, limit).map(toResult);
  }

  // Split "city, region" — the region part filters by state/province/country.
  const [cityPart, ...rest] = raw.split(",");
  const city = normalize(cityPart);
  let region = normalize(rest.join(" "));
  if (!city) return [];
  const regionMatches = (r: Row) => {
    if (!region) return true;
    const r2 = US_STATES[region] ?? region;
    return normalize(r[2]).startsWith(r2) || r[3].toLowerCase() === region;
  };

  const buckets: Row[][] = [[], [], []];
  for (let i = 0; i < rows.length; i++) {
    const k = keys[i];
    const score = k === city ? 0 : k.startsWith(city) ? 1 : k.includes(` ${city}`) ? 2 : -1;
    if (score < 0 || !regionMatches(rows[i])) continue;
    if (buckets[score].length < limit) buckets[score].push(rows[i]);
    if (buckets[0].length >= limit) break;
  }
  // No comma but last word may be a region: "cambridge ma" / "boston england"
  if (!region && buckets.every((b) => b.length === 0) && city.includes(" ")) {
    const words = city.split(" ");
    region = words.pop()!;
    return searchPlaces(`${words.join(" ")}, ${region}`, limit);
  }
  return buckets.flat().slice(0, limit).map(toResult);
}
