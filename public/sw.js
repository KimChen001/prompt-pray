// MOONA service worker: offline basics, no push.
// - Never touches /api/* (AI, place search): those always go to the network.
// - Hashed build files, card art, icons and fonts: cache-first (they never change under a URL).
// - Pages: network-first; the last good copy is used offline, else a route shell, else /offline.
// - At install it caches the main pages, every build file those pages need, and all 78 card images,
//   so drawing and reading cards works with no connection.
// The registration URL carries the build id (?v=…), so each deployment installs fresh caches.
const BUILD = new URL(self.location.href).searchParams.get("v") || "dev";
const VERSION = `moona-${BUILD}`;
const STATIC = `${VERSION}-static`;
const PAGES = `${VERSION}-pages`;

const SUITS = ["wands", "cups", "swords", "pentacles"];
const CARD_IDS = [
  ...Array.from({ length: 22 }, (_, i) => `major-${String(i).padStart(2, "0")}`),
  ...SUITS.flatMap((s) => Array.from({ length: 14 }, (_, i) => `${s}-${String(i + 1).padStart(2, "0")}`)),
];
const PRECACHE_STATIC = [...CARD_IDS.map((id) => `/cards/${id}.jpg`), "/cards/moona-back.svg", "/brand/moona-mark.svg", "/icons/icon-192.png"];
const PRECACHE_PAGES = ["/offline", "/", "/tarot", "/tarot/new", "/today", "/learn", "/chart", "/match", "/me", "/talk", "/whispers", "/about"];
// One cached copy per dynamic route; the page reads the real id from the address bar (src/lib/shell.ts).
const SHELLS = [
  { pattern: /^\/tarot\/r\/[^/]+$/, shell: "/tarot/r/_shell" },
  { pattern: /^\/match\/r\/[^/]+$/, shell: "/match/r/_shell" },
  { pattern: /^\/learn\/[^/]+\/[^/]+$/, shell: "/learn/_shell/_shell" },
  { pattern: /^\/talk\/c\/[^/]+$/, shell: "/talk/c/_shell" },
];

/** The shell page that can stand in for an uncached URL, or null. */
function shellFor(pathname) {
  return SHELLS.find((s) => s.pattern.test(pathname))?.shell ?? null;
}

/** Which strategy a same-origin GET uses. */
function strategyFor(url, mode) {
  if (url.pathname.startsWith("/api/")) return "network";
  if (url.searchParams.has("_rsc")) return "network"; // client-side navigation payloads
  if (url.pathname === "/sw.js") return "network";
  if (/^\/(_next\/static|cards|brand|icons|design)\//.test(url.pathname)) return "cache-first";
  if (mode === "navigate") return "page";
  return "network";
}

/** Build files a page needs: script/style URLs and chunk ids embedded in its HTML. */
function assetsInHtml(html) {
  return [...new Set([...html.matchAll(/\/_next\/static\/[^"'\s)\\]+/g)].map((m) => m[0]))];
}
/** Fonts and images a stylesheet references (absolute or relative to the stylesheet). */
function assetsInCss(css, cssPath) {
  return [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)]
    .map((m) => new URL(m[1], `https://x${cssPath}`).pathname)
    .filter((p) => p.startsWith("/_next/static/"));
}

// Exposed for the unit tests.
self.__moona = { strategyFor, shellFor, assetsInHtml, assetsInCss, CARD_IDS };

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const s = await caches.open(STATIC);
      await s.addAll(PRECACHE_STATIC);
      const p = await caches.open(PAGES);
      const pages = [...PRECACHE_PAGES, ...SHELLS.map((x) => x.shell)];
      // Pages are best-effort: one failing page must not block installation.
      await Promise.all(pages.map((u) => p.add(new Request(u, { credentials: "same-origin" })).catch(() => undefined)));
      const assets = new Set();
      for (const u of pages) {
        const res = await p.match(u);
        if (res) for (const a of assetsInHtml(await res.text())) assets.add(a);
      }
      const css = [];
      await Promise.all(
        [...assets].map(async (a) => {
          try {
            const res = await fetch(a);
            if (!res.ok) return;
            await s.put(a, res.clone());
            if (a.endsWith(".css")) css.push([a, await res.text()]);
          } catch {
            /* best-effort */
          }
        }),
      );
      await Promise.all(css.flatMap(([path, text]) => assetsInCss(text, path)).map((a) => s.add(a).catch(() => undefined)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith("moona-") && !key.startsWith(VERSION)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const strategy = strategyFor(url, req.mode);

  if (strategy === "cache-first") {
    event.respondWith(
      (async () => {
        const hit = await caches.match(req, { ignoreSearch: url.pathname.startsWith("/_next/static/") });
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) (await caches.open(STATIC)).put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  if (strategy === "page") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGES);
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(url.pathname, res.clone());
          return res;
        } catch {
          const shell = shellFor(url.pathname);
          return (
            (await cache.match(url.pathname)) ??
            (shell ? await cache.match(shell) : undefined) ??
            (await cache.match("/offline")) ??
            Response.error()
          );
        }
      })(),
    );
  }
  // "network": let the browser handle it normally.
});
