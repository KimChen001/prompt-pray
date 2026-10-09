import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The dev badge sits on top of the mobile tab bar.
  devIndicators: false,
  // Pin the root to this repo so a stray lockfile in a parent folder (e.g. the home directory) is ignored.
  turbopack: { root: path.join(__dirname) },
  // The place search reads this file at runtime; make sure deployments ship it with the route.
  outputFileTracingIncludes: { "/api/places": ["./data/places.json"] },
};

export default nextConfig;
