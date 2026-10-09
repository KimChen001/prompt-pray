"use client";
// Draws a ShareCard onto a 1080×1350 canvas (portrait, fits most feeds) and returns a PNG.
// Runs entirely in the browser; card art comes from this site's own public-domain images.
// Moonlight palette (same tokens as the site), a soft nebula glow and the MOONA mark.
import { cardImage } from "@/lib/tarot/deck";
import type { ShareCard } from "./content";

export const SHARE_SIZE = { width: 1080, height: 1350 };
const C = { bg0: "#07060c", bg1: "#0d0b16", line: "#24212f", text1: "#ece8f4", text2: "#b7b3c4", silver: "#bfc5d2", mist: "rgba(163, 148, 199, 0.22)" };
const SERIF = `"Instrument Serif", "Noto Serif SC", "Songti SC", "SimSun", serif`;
const SANS = `"Geist Variable", "Geist", "PingFang SC", "Microsoft YaHei", sans-serif`;

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Wraps text to a width; breaks between words, or between characters for CJK. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const tokens = text.match(/[\p{Script=Han}，。！？；：、（）《》“”「」…—]|[^\s\p{Script=Han}，。！？；：、（）《》“”「」…—]+\s*|\s+/gu) ?? [text];
  const lines: string[] = [];
  let cur = "";
  for (const t of tokens) {
    const next = cur + t;
    if (ctx.measureText(next.trimEnd()).width > maxWidth && cur) {
      lines.push(cur.trimEnd());
      cur = t.trimStart();
      if (lines.length === maxLines) break;
    } else cur = next;
  }
  if (lines.length < maxLines && cur.trim()) lines.push(cur.trimEnd());
  if (lines.length === maxLines && tokens.join("").trim().length > lines.join("").length + 1) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1}$/u, "…");
  }
  return lines;
}

export async function renderShareCard(card: ShareCard): Promise<Blob> {
  try {
    await Promise.all([document.fonts.load(`400 64px ${SERIF}`), document.fonts.load(`400 28px ${SANS}`)]);
  } catch {
    /* fall back to system fonts */
  }
  const { width: W, height: H } = SHARE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const pad = 84;

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, C.bg1);
  g.addColorStop(1, C.bg0);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // a soft misty-violet glow at the top right, like the nebula on the home page
  const glow = ctx.createRadialGradient(W * 0.86, H * 0.08, 0, W * 0.86, H * 0.08, W * 0.75);
  glow.addColorStop(0, C.mist);
  glow.addColorStop(1, "rgba(163, 148, 199, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.strokeRect(36, 36, W - 72, H - 72);

  let y = pad + 20;
  ctx.textBaseline = "top";
  ctx.fillStyle = C.text2;
  ctx.font = `500 26px ${SANS}`;
  ctx.fillText(card.eyebrow.toUpperCase(), pad, y);
  y += 56;

  ctx.fillStyle = C.text1;
  ctx.font = `400 76px ${SERIF}`;
  for (const l of wrap(ctx, card.title, W - pad * 2, 2)) {
    ctx.fillText(l, pad, y);
    y += 84;
  }
  if (card.subtitle) {
    ctx.fillStyle = C.text2;
    ctx.font = `400 28px ${SANS}`;
    ctx.fillText(card.subtitle, pad, y + 4);
    y += 52;
  }
  if (card.quote) {
    ctx.fillStyle = C.silver;
    ctx.font = `italic 400 38px ${SERIF}`;
    for (const l of wrap(ctx, `“${card.quote}”`, W - pad * 2, 3)) {
      ctx.fillText(l, pad, y + 12);
      y += 48;
    }
    y += 12;
  }
  y += 24;

  if (card.cards?.length) {
    const n = card.cards.length;
    const gap = 28;
    const cw = Math.min(n === 1 ? 300 : 210, (W - pad * 2 - gap * (n - 1)) / n);
    const ch = cw * 1.72;
    const total = n * cw + (n - 1) * gap;
    let x = (W - total) / 2;
    const imgs = await Promise.all(card.cards.map((c) => loadImage(cardImage(c.id))));
    imgs.forEach((img, i) => {
      ctx.save();
      if (card.cards![i].reversed) {
        ctx.translate(x + cw / 2, y + ch / 2);
        ctx.rotate(Math.PI);
        ctx.translate(-(x + cw / 2), -(y + ch / 2));
      }
      if (img) ctx.drawImage(img, x, y, cw, ch);
      else {
        ctx.fillStyle = C.line;
        ctx.fillRect(x, y, cw, ch);
      }
      ctx.restore();
      ctx.strokeStyle = C.line;
      ctx.strokeRect(x, y, cw, ch);
      x += cw + gap;
    });
    y += ch + 36;
    const lineBudget = n === 1 ? 4 : n === 3 ? 2 : 1;
    for (const c of card.cards) {
      if (y > H - 260) break;
      ctx.fillStyle = C.text1;
      ctx.font = `600 30px ${SANS}`;
      ctx.fillText(c.name, pad, y);
      y += 40;
      ctx.fillStyle = C.text2;
      ctx.font = `400 28px ${SANS}`;
      for (const l of wrap(ctx, c.line, W - pad * 2, lineBudget)) {
        ctx.fillText(l, pad, y);
        y += 38;
      }
      y += 14;
    }
  }

  // Without card art, centre the score and rows in the free space instead of crowding the top.
  const rowH = card.cards?.length ? 92 : 128;
  if (!card.cards?.length && (card.big || card.rows?.length)) {
    const block = (card.big ? 240 : 0) + (card.rows?.length ?? 0) * rowH;
    y = Math.max(y + 40, (H - block) / 2);
  }
  if (card.big) {
    if (card.bigLabel) {
      ctx.fillStyle = C.text2;
      ctx.font = `500 28px ${SANS}`;
      ctx.fillText(card.bigLabel.toUpperCase(), pad, y - 36);
    }
    ctx.fillStyle = C.silver;
    ctx.font = `400 220px ${SERIF}`;
    ctx.fillText(card.big, pad, y);
    y += 240;
  }
  if (card.rows?.length) {
    for (const r of card.rows) {
      ctx.fillStyle = C.text2;
      ctx.font = `500 32px ${SANS}`;
      ctx.fillText(r.label, pad, y + 14);
      ctx.fillStyle = C.text1;
      ctx.font = `400 56px ${SERIF}`;
      const vw = ctx.measureText(r.value).width;
      ctx.fillText(r.value, W - pad - vw, y);
      y += rowH;
      ctx.strokeStyle = C.line;
      ctx.beginPath();
      ctx.moveTo(pad, y - 18);
      ctx.lineTo(W - pad, y - 18);
      ctx.stroke();
    }
  }
  if (card.note && y < H - 300) {
    ctx.fillStyle = C.silver;
    ctx.font = `italic 400 34px ${SERIF}`;
    for (const l of wrap(ctx, card.note, W - pad * 2, 2)) {
      ctx.fillText(l, pad, y + 8);
      y += 44;
    }
  }

  // Footer text wraps in the space left of the wordmark, so the two never overlap.
  ctx.font = `400 30px ${SERIF}`;
  const brand = "MOONA";
  const brandW = ctx.measureText(brand).width;
  ctx.fillStyle = C.silver;
  ctx.fillText(brand, W - pad - brandW, H - pad - 34);
  const mark = await loadImage("/brand/moona-mark.svg");
  if (mark) ctx.drawImage(mark, W - pad - brandW - 48, H - pad - 40, 38, 38);
  ctx.fillStyle = C.text2;
  ctx.font = `400 22px ${SANS}`;
  const foot = wrap(ctx, card.footer, W - pad * 2 - brandW - 80, 2);
  foot.forEach((l, i) => ctx.fillText(l, pad, H - pad - 30 - (foot.length - 1 - i) * 30));

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"));
}
