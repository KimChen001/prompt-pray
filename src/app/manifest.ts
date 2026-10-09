import type { MetadataRoute } from "next";

// Installable web app (plan v0.2: website + PWA). Install only; no push notifications.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MOONA — tarot & astrology",
    short_name: "MOONA",
    description: "A cyber-mystic tarot and astrology companion. Draw your own cards; see why every reading says what it says.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0b0c10",
    theme_color: "#0b0c10",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
