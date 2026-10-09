"use client";
// Full-screen starfield, ported from the team's Figma Make prototype (Moona/src/app/App.tsx, Cosmos):
// stars stream out of the orb towards the viewer with soft trails, speed up when the pointer moves,
// a faint violet aura follows the pointer, and a nebula breathes behind a surfacing whisper.
// Added for the real site: honours Motion (Off = no canvas, Reduced = one still frame), pauses in
// background tabs, fewer stars and a lower pixel ratio on phones, and a calmer drift on reading pages.
import { useEffect, useRef } from "react";
import { useMotionLevel } from "@/lib/motion";
import { glow, mouse } from "./state";

export function Cosmos({ calm = false }: { calm?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const level = useMotionLevel();
  const calmRef = useRef(calm);
  calmRef.current = calm;

  useEffect(() => {
    if (level === "off") return;
    const cv = ref.current!, ctx = cv.getContext("2d");
    if (!ctx) return;
    const phone = window.matchMedia?.("(pointer: coarse)").matches || innerWidth < 768;
    let w = 0, h = 0, raf = 0, dpr = 1;
    const resize = () => { dpr = Math.min(devicePixelRatio, phone ? 1.5 : 2); w = innerWidth; h = innerHeight; cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    const mv = (e: PointerEvent) => {
      const nx = e.clientX / w, ny = e.clientY / h;
      mouse.vx = nx - mouse.x; mouse.vy = ny - mouse.y; mouse.x = nx; mouse.y = ny;
    };
    resize(); addEventListener("resize", resize); addEventListener("pointermove", mv, { passive: true });

    // tarot palette: pale violet, candle gold, dusty rose, moon white
    const COLS = ["245,242,255", "245,242,255", "205,198,255", "232,205,160"];
    const stars = Array.from({ length: phone ? 160 : 300 }, () => ({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: Math.random(), c: COLS[(Math.random() * COLS.length) | 0] }));
    const cam = { x: 0.5, y: 0.36 };
    let speed = 0.0025, last = performance.now(), glowA = 0;

    const frame = (t: number, still: boolean) => {
      const dt = still ? 0 : Math.min((t - last) / 16.7, 3); last = t;
      // fade instead of clear → soft trails
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = still ? "rgb(7,6,12)" : "rgba(7,6,12,0.28)";
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";

      const energy = Math.min(Math.hypot(mouse.vx, mouse.vy) * 40, 1);
      const base = calmRef.current ? 0.0008 : 0.0025;
      speed += (base + energy * (calmRef.current ? 0.004 : 0.02) - speed) * 0.04;
      mouse.vx *= 0.9; mouse.vy *= 0.9;
      // vanishing point drifts gently toward the cursor
      const orb = document.getElementById("orb")?.getBoundingClientRect();
      const ocx = orb ? (orb.left + orb.width / 2) / w : 0.5, ocy = orb ? (orb.top + orb.height / 2) / h : 0.36;
      const hole = orb ? orb.width * 0.4 : 150;
      cam.x += (ocx + (mouse.x - 0.5) * 0.12 - cam.x) * (still ? 1 : 0.03);
      cam.y += (ocy + (mouse.y - 0.5) * 0.1 - cam.y) * (still ? 1 : 0.03);
      const cx = cam.x * w, cy = cam.y * h, F = Math.max(w, h) * 0.5;
      const dim = calmRef.current ? 0.55 : 1;

      for (const s of stars) {
        const pz = s.z;
        s.z -= speed * dt;
        if (s.z <= 0.02) { s.x = (Math.random() - 0.5) * 2; s.y = (Math.random() - 0.5) * 2; s.z = 1; continue; }
        const x = cx + (s.x / s.z) * F, y = cy + (s.y / s.z) * F;
        const px = cx + (s.x / pz) * F, py = cy + (s.y / pz) * F;
        if (x < -50 || x > w + 50 || y < -50 || y > h + 50) { s.z = 1; continue; }
        const dc = Math.hypot(x - cx, y - cy);
        if (dc < hole) continue;
        const a = Math.min((1 - s.z) * 1.2, 1) * Math.min((dc - hole) / 120, 1) * dim;
        ctx.strokeStyle = `rgba(${s.c},${a * 0.85})`;
        ctx.lineWidth = (1 - s.z) * 1.4 + 0.3;
        ctx.beginPath();
        if (still) ctx.arc(x, y, ctx.lineWidth * 0.6, 0, Math.PI * 2);
        else { ctx.moveTo(px, py); ctx.lineTo(x, y); }
        if (still) { ctx.fillStyle = ctx.strokeStyle; ctx.fill(); } else ctx.stroke();
      }

      const mx = mouse.x * w, my = mouse.y * h;

      // nebula breathing behind a surfacing whisper
      glowA += (glow.a - glowA) * (still ? 1 : 0.01);
      if (glowA > 0.01) {
        const gx = glow.x * w, gy = glow.y * h, gr = 220;
        const ng = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
        ng.addColorStop(0, `rgba(150,125,240,${0.05 * glowA})`); ng.addColorStop(0.5, `rgba(201,169,110,${0.02 * glowA})`); ng.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = ng; ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
      }

      // soft cursor glow — the "aura"
      if (!still) {
        const cg = ctx.createRadialGradient(mx, my, 0, mx, my, 160);
        cg.addColorStop(0, `rgba(170,140,255,${0.03 + energy * 0.05})`); cg.addColorStop(1, "rgba(170,140,255,0)");
        ctx.fillStyle = cg; ctx.fillRect(mx - 160, my - 160, 320, 320);
      }
    };

    const still = level === "reduced";
    const loop = (t: number) => {
      frame(t, false);
      raf = requestAnimationFrame(loop);
    };
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!still && document.visibilityState === "visible") { last = performance.now(); raf = requestAnimationFrame(loop); }
    };
    if (still) {
      // a still sky: draw once (after layout, so the orb position is known), redraw on resize
      const once = () => frame(performance.now(), true);
      raf = requestAnimationFrame(once);
      addEventListener("resize", once);
      return () => { cancelAnimationFrame(raf); removeEventListener("resize", resize); removeEventListener("resize", once); removeEventListener("pointermove", mv); };
    }
    raf = requestAnimationFrame(loop);
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelAnimationFrame(raf); removeEventListener("resize", resize); removeEventListener("pointermove", mv); document.removeEventListener("visibilitychange", onVis); };
  }, [level]);

  if (level === "off") return null;
  return <canvas ref={ref} className="pointer-events-none fixed inset-0 h-full w-full" aria-hidden="true" />;
}
