import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Load public/sw.js in a sandbox with a minimal `self`, then test its routing decisions.
function loadWorker() {
  const listeners: Record<string, unknown> = {};
  const self: Record<string, unknown> = { location: { origin: "https://moona.test", href: "https://moona.test/sw.js?v=test" }, addEventListener: (t: string, f: unknown) => (listeners[t] = f) };
  runInNewContext(readFileSync("public/sw.js", "utf8"), { self, caches: {}, fetch: () => undefined, Request, Response, URL, console });
  const api = self.__moona as {
    strategyFor: (u: URL, mode: string) => string;
    shellFor: (p: string) => string | null;
    assetsInHtml: (html: string) => string[];
    assetsInCss: (css: string, path: string) => string[];
    CARD_IDS: string[];
  };
  return { strategy: api.strategyFor, shell: api.shellFor, api, listeners };
}

describe("service worker", () => {
  const { strategy, shell, api, listeners } = loadWorker();
  const s = (path: string, mode = "cors") => strategy(new URL(path, "https://moona.test"), mode);

  it("never caches API calls (AI, place search) or the worker itself", () => {
    for (const p of ["/api/ai/tarot", "/api/ai/chat", "/api/places?q=bos", "/api/ai/status"]) {
      expect(s(p), p).toBe("network");
      expect(s(p, "navigate"), p).toBe("network");
    }
    expect(s("/sw.js")).toBe("network");
    expect(s("/tarot?_rsc=abc")).toBe("network");
  });
  it("serves hashed build files and art cache-first, pages network-first", () => {
    for (const p of ["/_next/static/chunks/app.js", "/cards/major-18.jpg", "/brand/moona-logo.webp", "/icons/icon-192.png"]) expect(s(p), p).toBe("cache-first");
    expect(s("/tarot/new", "navigate")).toBe("page");
    expect(s("/learn/card/major-18", "navigate")).toBe("page");
    expect(s("/manifest.webmanifest")).toBe("network");
  });
  it("registers install, activate and fetch handlers and precaches all 78 cards", () => {
    expect(Object.keys(listeners).sort()).toEqual(["activate", "fetch", "install"]);
    const ids = api.CARD_IDS;
    expect(ids).toHaveLength(78);
    expect(new Set(ids).size).toBe(78);
    for (const id of ids) expect(existsSync(`public/cards/${id}.jpg`), id).toBe(true);
  });
  it("stands in a cached shell for uncached reading, match and Learn pages only", () => {
    expect(shell("/tarot/r/abc123")).toBe("/tarot/r/_shell");
    expect(shell("/match/r/6f1c-uuid")).toBe("/match/r/_shell");
    expect(shell("/learn/card/major-18")).toBe("/learn/_shell/_shell");
    expect(shell("/tarot/r/abc/extra")).toBeNull();
    expect(shell("/tarot/new")).toBeNull();
    expect(shell("/learn")).toBeNull();
    expect(shell("/me")).toBeNull();
  });
  it("finds the build files a page needs, including escaped chunk ids and CSS fonts", () => {
    const html = '<script src="/_next/static/chunks/a1.js" async></script><link rel="stylesheet" href="/_next/static/chunks/s.css">'
      + '<script>self.__next_f.push([1,"9:I[123,[\\"/_next/static/chunks/b2.js\\"],\\"default\\"]"])</script>';
    expect(api.assetsInHtml(html).sort()).toEqual(["/_next/static/chunks/a1.js", "/_next/static/chunks/b2.js", "/_next/static/chunks/s.css"]);
    const css = '@font-face{src:url(../media/inter.woff2) format("woff2")} .x{background:url("/_next/static/media/bg.png")} .y{background:url(data:image/png;base64,AAA)}';
    expect(api.assetsInCss(css, "/_next/static/chunks/s.css").sort()).toEqual(["/_next/static/media/bg.png", "/_next/static/media/inter.woff2"]);
  });
});
