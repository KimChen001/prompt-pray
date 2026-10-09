import path from "node:path";
import type { NextConfig } from "next";

// One id per build: the service worker is registered as /sw.js?v=<id>, so a new deployment
// installs fresh offline caches that match its pages and chunks.
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || Date.now().toString(36);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
  poweredByHeader: false,
  // The dev badge sits on top of the mobile tab bar.
  devIndicators: false,
  // Pin the root to this repo so a stray lockfile in a parent folder (e.g. the home directory) is ignored.
  turbopack: { root: path.join(__dirname) },
  // The place search reads this file at runtime; make sure deployments ship it with the route.
  outputFileTracingIncludes: { "/api/places": ["./data/places.json"] },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // The service worker must never be cached, so updates reach users.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
