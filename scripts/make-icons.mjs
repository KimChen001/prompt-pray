// Generates the PWA icons from the brand logo (public/brand/moona-logo.webp) on the app's dark
// background. Uses sharp, which Next.js installs for image optimisation.
// Usage: node scripts/make-icons.mjs   (re-run after the logo changes; commit the PNGs)
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const SRC = "public/brand/moona-logo.webp";
const BG = { r: 11, g: 12, b: 16, alpha: 1 }; // --bg-0
mkdirSync("public/icons", { recursive: true });

// The logo is a round wheel on a light-grey square: keep only the wheel (circle mask).
const meta = await sharp(SRC).metadata();
const r = Math.min(meta.width, meta.height) / 2 - 4;
const mask = Buffer.from(`<svg width="${meta.width}" height="${meta.height}"><circle cx="${meta.width / 2}" cy="${meta.height / 2}" r="${r}" fill="#fff"/></svg>`);
const wheel = await sharp(SRC).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();

/** `scale` = share of the square the logo may fill (maskable icons keep a safe zone). */
async function icon(size, scale, out) {
  const inner = Math.round(size * scale);
  const logo = await sharp(wheel).resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, gravity: "centre" }])
    .png()
    .toFile(out);
  console.log("wrote", out);
}

await icon(192, 0.86, "public/icons/icon-192.png");
await icon(512, 0.86, "public/icons/icon-512.png");
await icon(512, 0.66, "public/icons/maskable-512.png"); // inside the 80% safe circle
await icon(180, 0.82, "public/icons/apple-touch-icon.png");
await icon(48, 0.92, "public/icons/favicon-48.png");
