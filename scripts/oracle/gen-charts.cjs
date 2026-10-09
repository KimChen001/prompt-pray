// Regenerates tests/fixtures/charts.sweph.json with Swiss Ephemeris (test oracle only).
// Swiss Ephemeris is AGPL, so it is NOT a project dependency. To run:
//   mkdir /tmp/oracle && cd /tmp/oracle && npm init -y && npm install sweph
//   node <repo>/scripts/oracle/gen-charts.cjs <repo>/tests/fixtures/charts.sweph.json
// (run from /tmp/oracle so require('sweph') resolves there)
module.paths.unshift(require('path').join(process.cwd(), 'node_modules'));
const swe = require('sweph');
const { constants: C } = swe;
const births = [
  { id: 'boston-1999', label: 'Boston, 1999-08-14 07:30 EDT', utc: '1999-08-14T11:30:00Z', lat: 42.3601, lon: -71.0589 },
  { id: 'la-1995', label: 'Los Angeles, 1995-03-12 23:45 PST', utc: '1995-03-13T07:45:00Z', lat: 34.0522, lon: -118.2437 },
  { id: 'shanghai-2003', label: 'Shanghai, 2003-06-01 12:00 CST', utc: '2003-06-01T04:00:00Z', lat: 31.2304, lon: 121.4737 },
  { id: 'sydney-1988', label: 'Sydney, 1988-12-25 06:15 AEDT', utc: '1988-12-24T19:15:00Z', lat: -33.8688, lon: 151.2093 },
  { id: 'london-1965', label: 'London, 1965-11-03 18:20 GMT', utc: '1965-11-03T18:20:00Z', lat: 51.5074, lon: -0.1278 },
  { id: 'kolkata-2010', label: 'Kolkata, 2010-01-15 03:05 IST', utc: '2010-01-14T21:35:00Z', lat: 22.5726, lon: 88.3639 },
  { id: 'reykjavik-1992', label: 'Reykjavik, 1992-07-20 14:00 GMT', utc: '1992-07-20T14:00:00Z', lat: 64.1466, lon: -21.9426 },
  { id: 'cambridge-2026', label: 'Cambridge MA, 2026-10-24 10:00 EDT', utc: '2026-10-24T14:00:00Z', lat: 42.3736, lon: -71.1097 },
];
const BODIES = ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
const flags = C.SEFLG_MOSEPH | C.SEFLG_SPEED;
const out = births.map(b => {
  const d = new Date(b.utc);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const jd = swe.julday(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, C.SE_GREG_CAL);
  const planets = {};
  BODIES.forEach((name, i) => {
    const r = swe.calc_ut(jd, i, flags);
    if (r.error) throw new Error(r.error);
    planets[name] = { lon: +r.data[0].toFixed(4), speed: +r.data[3].toFixed(4) };
  });
  const p = swe.houses(jd, b.lat, b.lon, 'P');
  const w = swe.houses(jd, b.lat, b.lon, 'W');
  return { ...b, jd, planets, asc: +p.data.points[0].toFixed(4), mc: +p.data.points[1].toFixed(4),
    placidus: p.data.houses.map(x => +x.toFixed(4)), wholeSign: w.data.houses.map(x => +x.toFixed(4)) };
});
require('fs').writeFileSync(process.argv[2], JSON.stringify({ source: 'Swiss Ephemeris ' + swe.version() + ' (Moshier), generated as a test oracle', charts: out }, null, 2) + '\n');
console.log(out.map(c => `${c.id}: Sun ${c.planets.sun.lon} Moon ${c.planets.moon.lon} Asc ${c.asc} MC ${c.mc}`).join('\n'));
