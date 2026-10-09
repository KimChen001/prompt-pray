// Regenerates tests/fixtures/sky-2026.sweph.json (test oracle only; see gen-charts.cjs for how to run).
// Lunations (new/full moon), retrograde stations of Mercury/Venus/Mars, and Sun ingresses in 2026.
module.paths.unshift(require('path').join(process.cwd(), 'node_modules'));
const swe = require('sweph');
const { constants: C } = swe;
const FLAGS = C.SEFLG_MOSEPH | C.SEFLG_SPEED;
const jdOf = (ms) => 2440587.5 + ms / 86400e3;
const calc = (ms, body) => swe.calc_ut(jdOf(ms), body, FLAGS).data;
const norm = (d) => ((d % 360) + 360) % 360;
const signed = (d) => ((d + 540) % 360) - 180;

function findCrossings(start, end, stepMs, f) {
  // f(ms) returns a signed value; record each sign change from negative to positive, refined to 10 s.
  const out = [];
  let prevT = start, prev = f(start);
  for (let t = start + stepMs; t <= end; t += stepMs) {
    const v = f(t);
    if (prev < 0 && v >= 0 && Math.abs(v - prev) < 90) {
      let lo = prevT, hi = t;
      while (hi - lo > 10e3) { const mid = (lo + hi) / 2; if (f(mid) < 0) lo = mid; else hi = mid; }
      out.push(new Date(Math.round(hi / 60e3) * 60e3).toISOString());
    }
    prevT = t; prev = v;
  }
  return out;
}

const start = Date.UTC(2026, 0, 1), end = Date.UTC(2027, 0, 1), H = 3600e3;
const elong = (ms) => norm(calc(ms, C.SE_MOON)[0] - calc(ms, C.SE_SUN)[0]);
const out = {
  source: 'Swiss Ephemeris ' + swe.version() + ' (Moshier), generated as a test oracle',
  newMoons: findCrossings(start, end, H, (ms) => signed(elong(ms))),
  fullMoons: findCrossings(start, end, H, (ms) => signed(elong(ms) - 180)),
  stations: {},
  sunIngresses: [],
};
for (const [name, body] of [['mercury', C.SE_MERCURY], ['venus', C.SE_VENUS], ['mars', C.SE_MARS]]) {
  out.stations[name] = {
    retrograde: findCrossings(start, end, H, (ms) => -calc(ms, body)[3]),
    direct: findCrossings(start, end, H, (ms) => calc(ms, body)[3]),
  };
}
// Sun ingresses: crossing each multiple of 30°.
for (let k = 0; k < 12; k++) {
  const target = k * 30;
  out.sunIngresses.push(...findCrossings(start, end, 6 * H, (ms) => signed(calc(ms, C.SE_SUN)[0] - target)).map((t) => ({ sign: k, at: t })));
}
out.sunIngresses.sort((a, b) => a.at.localeCompare(b.at));
require('fs').writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + '\n');
console.log(`new ${out.newMoons.length}, full ${out.fullMoons.length}, ingresses ${out.sunIngresses.length}`);
for (const [k, v] of Object.entries(out.stations)) console.log(k, 'R', v.retrograde.join(' '), '| D', v.direct.join(' '));
