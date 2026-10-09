import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The dev badge sits on top of the mobile tab bar.
  devIndicators: false,
};

export default nextConfig;
