import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// House rule (user, 2026-10-09): MOONA never shows emoji. Zodiac signs and planets are SVG icons,
// because several Unicode symbols (♈–♓, ♀, ♂, ↗ …) turn into colour emoji on some platforms even
// with a text-presentation selector. This fails on any emoji-capable character in shipped code,
// content or design assets (ASCII digits, # and * are excluded; they only form emoji in keycaps).
const EMOJI = /(?![\x00-\x7f])\p{Emoji}/u;
const ROOTS = ["src", "content", "public/design", "eval", "scripts"];
const EXT = /\.(tsx?|mjs|json|css|svg|md)$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : EXT.test(f) ? [p] : [];
  });
}

describe("no emoji", () => {
  it("appear anywhere in shipped code, content or design assets", () => {
    const offenders: string[] = [];
    for (const f of ROOTS.flatMap(files)) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const m = line.match(EMOJI);
        if (m) offenders.push(`${f}:${i + 1} ${m[0]} U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the check itself catches zodiac symbols and colour emoji but not plain arrows or stars", () => {
    for (const ch of ["♈", "♓", "♀", "♂", "↗", "⭐", "🌙"]) expect(EMOJI.test(ch), ch).toBe(true);
    for (const ch of ["→", "↓", "✦", "✧", "☉", "☽", "☌", "△", "°", "·", "中"]) expect(EMOJI.test(ch), ch).toBe(false);
  });
});
