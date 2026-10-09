// Builds data/places.json from GeoNames (CC BY 4.0, https://www.geonames.org/):
// every place with population ≥ 5000, with its IANA time zone and Chinese aliases.
// Usage: node scripts/build-places.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = "https://download.geonames.org/export/dump/";
const CACHE = join(tmpdir(), "moona-geonames");

async function cached(file) {
  const path = join(CACHE, file);
  if (!existsSync(path)) {
    await mkdir(CACHE, { recursive: true });
    const res = await fetch(BASE + file);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
  }
  return readFile(path);
}

/** Minimal ZIP reader: returns the named entry's bytes (deflate or stored). */
function unzip(buf, name) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (entry === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nameLen + extra + comment;
  }
  throw new Error(`${name} not found in zip`);
}

const CJK = /[\u3400-\u9fff]/;
const admin1 = new Map(
  (await cached("admin1CodesASCII.txt")).toString("utf8").split("\n").filter(Boolean).map((l) => {
    const [code, , ascii] = l.split("\t");
    return [code, ascii];
  }),
);

const rows = unzip(await cached("cities5000.zip"), "cities5000.txt").toString("utf8").split("\n").filter(Boolean);
const zones = [];
const zoneIndex = new Map();
const places = [];
for (const line of rows) {
  const f = line.split("\t");
  const [, name, ascii, alternates, lat, lon, , , cc, , a1, , , , pop, , , tz] = f;
  if (!tz) continue;
  if (!zoneIndex.has(tz)) { zoneIndex.set(tz, zones.length); zones.push(tz); }
  const zh = [...new Set(alternates.split(",").filter((a) => CJK.test(a)))].slice(0, 3).join("|");
  places.push([name, ascii, admin1.get(`${cc}.${a1}`) ?? "", cc, +(+lat).toFixed(4), +(+lon).toFixed(4), zoneIndex.get(tz), +pop, zh]);
}
places.sort((a, b) => b[7] - a[7]);

await mkdir("data", { recursive: true });
const out = {
  source: "GeoNames cities5000 (CC BY 4.0, https://www.geonames.org/), built by scripts/build-places.mjs",
  fields: ["name", "ascii", "admin1", "country", "lat", "lon", "tz", "population", "zh"],
  zones,
  places,
};
await writeFile("data/places.json", JSON.stringify(out));
console.log(`places: ${places.length}, zones: ${zones.length}, size: ${(JSON.stringify(out).length / 1e6).toFixed(2)} MB`);
