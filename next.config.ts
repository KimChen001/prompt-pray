import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The dev badge sits on top of the mobile tab bar.
  devIndicators: false,
  // Pin the root to this repo so a stray lockfile in a parent folder (e.g. the home directory) is ignored.
  turbopack: { root: path.join(__dirname) },
};

export default nextConfig;
