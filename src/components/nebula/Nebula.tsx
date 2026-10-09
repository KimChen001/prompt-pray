"use client";
// Reusable nebula orb (with an optional interactive star-dust field). A static CSS orb is
// server-rendered and painted first; the WebGL layer (nebula-gl.ts) loads on demand and fades in over
// it. Anything that fails (no WebGL, context lost, too slow, motion off) leaves the static orb —
// buttons, scrolling, selecting text and typing never depend on it, and it never takes pointer
// events (it only listens passively). One orb per page.
//
// Modes map to real product states (design supplement §6):
//   idle   – home page, slow breathing; dust parts around the pointer and bursts on a tap
//   gather – shuffling / picking cards: the orb contracts, the dust flows into it
//   pulse  – a real AI request is in flight (the page also shows a text status)
//   settle – a new result just arrived: a short brightening, then quiet
//   quiet  – reading or chatting: low energy, slow
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMotionLevel } from "@/lib/motion";
import type { NebulaHandle, NebulaMode } from "./nebula-gl";

export type { NebulaMode } from "./nebula-gl";

/** How far the dust field reaches, as a multiple of the orb box. */
const FIELD = 1.9;
const BOX = 1.08; // keep in sync with nebula-gl.ts

interface Props {
  mode?: NebulaMode;
  /** CSS size of the orb's square box, e.g. "clamp(220px, 66vw, 280px)". */
  size: string;
  className?: string;
  /** Pointer light, parallax and tap ripple. */
  interactive?: boolean;
  /** Star dust orbiting around the orb (drawn beyond the orb box). */
  particles?: boolean;
}

function prefersLite(): boolean {
  const coarse = window.matchMedia?.("(pointer: coarse)").matches;
  const cores = navigator.hardwareConcurrency ?? 8;
  return !!coarse || window.innerWidth < 768 || cores <= 4;
}

export function Nebula({ mode = "idle", size, className, interactive = false, particles = false }: Props) {
  const level = useMotionLevel();
  const wrapRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<NebulaHandle | null>(null);
  const modeRef = useRef(mode);
  const [live, setLive] = useState(false);

  useEffect(() => {
    modeRef.current = mode;
    handleRef.current?.setMode(mode);
  }, [mode]);

  useEffect(() => {
    if (level === "off") return;
    const wrap = wrapRef.current!;
    // A fresh canvas per run: a canvas whose context was released can't be reused.
    const canvas = document.createElement("canvas");
    canvas.className = "nebula-canvas";
    wrap.appendChild(canvas);
    let disposed = false;
    let visible = true;
    let pageVisible = document.visibilityState === "visible";
    const cleanups: (() => void)[] = [];

    const fail = () => {
      if (disposed) return;
      handleRef.current?.destroy();
      handleRef.current = null;
      setLive(false);
    };

    import("./nebula-gl")
      .then(({ createNebula }) => {
        if (disposed) return;
        let handle: NebulaHandle;
        try {
          handle = createNebula(canvas, { lite: prefersLite(), still: level === "reduced", field: particles ? FIELD : 1, particles, onFail: fail });
        } catch {
          return fail();
        }
        handleRef.current = handle;
        handle.setMode(modeRef.current);
        const sync = () => handle.setRunning(visible && pageVisible);
        sync();
        setLive(true);

        const io = new IntersectionObserver(([e]) => {
          visible = e.isIntersecting;
          sync();
        });
        io.observe(canvas);
        const onVis = () => {
          pageVisible = document.visibilityState === "visible";
          sync();
        };
        document.addEventListener("visibilitychange", onVis);
        const ro = new ResizeObserver(() => handle.resize());
        ro.observe(wrap);
        cleanups.push(() => io.disconnect(), () => document.removeEventListener("visibilitychange", onVis), () => ro.disconnect());

        if (interactive && level === "full") {
          const toOrb = (x: number, y: number) => {
            const r = wrap.getBoundingClientRect();
            return { x: ((x - r.left) / r.width * 2 - 1) * BOX, y: -((y - r.top) / r.height * 2 - 1) * BOX };
          };
          const onMove = (e: PointerEvent) => {
            // Mouse: always; touch/pen: while pressed (a finger dragging through the dust).
            if (e.pointerType !== "mouse" && e.buttons === 0) return;
            const p = toOrb(e.clientX, e.clientY);
            handle.setPointer(p);
            if (e.pointerType === "mouse") {
              const clamp = (v: number) => Math.max(-1, Math.min(1, v / 3));
              handle.setTilt(clamp(p.x) * 0.08, clamp(p.y) * 0.08);
            }
          };
          const onDown = (e: PointerEvent) => {
            const p = toOrb(e.clientX, e.clientY);
            if (Math.hypot(p.x, p.y) < (particles ? FIELD * BOX : 0.9)) {
              handle.ripple(p.x, p.y);
              handle.setPointer(p);
            }
          };
          const onLeave = () => handle.setPointer(null);
          const onUp = (e: PointerEvent) => e.pointerType !== "mouse" && handle.setPointer(null);
          window.addEventListener("pointermove", onMove, { passive: true });
          window.addEventListener("pointerdown", onDown, { passive: true });
          window.addEventListener("pointerup", onUp, { passive: true });
          window.addEventListener("pointercancel", onLeave, { passive: true });
          document.documentElement.addEventListener("pointerleave", onLeave);
          cleanups.push(
            () => window.removeEventListener("pointermove", onMove),
            () => window.removeEventListener("pointerdown", onDown),
            () => window.removeEventListener("pointerup", onUp),
            () => window.removeEventListener("pointercancel", onLeave),
            () => document.documentElement.removeEventListener("pointerleave", onLeave),
          );
        }
      })
      .catch(fail);

    return () => {
      disposed = true;
      cleanups.forEach((c) => c());
      handleRef.current?.destroy();
      handleRef.current = null;
      canvas.remove();
      setLive(false);
    };
  }, [level, interactive, particles]);

  return (
    <div
      ref={wrapRef}
      className={`nebula${className ? ` ${className}` : ""}`}
      data-mode={mode}
      data-live={live}
      data-field={particles ? "true" : undefined}
      style={{ "--orb": size } as CSSProperties}
      aria-hidden="true"
    >
      <span className="nebula-static" />
    </div>
  );
}
