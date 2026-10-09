"use client";
// The prototype's Ether orb at any size, for inner pages (the ritual, today, readings, conversations).
// Same layers as the home Orb (aura, feathered shader, warm tint); its movement follows real states
// only (design supplement §6):
//   idle   – resting
//   gather – shuffling / picking cards: contracts and turns faster
//   pulse  – a real AI request is in flight: a cyan ring (cyan is reserved for AI) — the page also
//            says so in text
//   settle – a new result just arrived: a short brightening, then quiet
//   quiet  – reading or chatting: slow and a little dimmer
// Motion "reduced" shows a still frame; "off", no WebGL or a lost context shows a static orb. It never
// takes pointer events.
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useMotionLevel } from "@/lib/motion";
import { ShaderCanvas } from "./ShaderCanvas";

export type OrbMode = "idle" | "gather" | "pulse" | "settle" | "quiet";

const SPEED: Record<OrbMode, number> = { idle: 1, gather: 2.4, pulse: 1.9, settle: 1.3, quiet: 0.55 };
const SCALE: Record<OrbMode, number> = { idle: 1, gather: 0.86, pulse: 1, settle: 1.06, quiet: 1 };
const LIGHT: Record<OrbMode, number> = { idle: 1, gather: 1.1, pulse: 1.1, settle: 1.35, quiet: 0.85 };

export function StateOrb({ mode = "idle", size, className = "" }: { mode?: OrbMode; size: string; className?: string }) {
  const level = useMotionLevel();
  const wrap = useRef<HTMLDivElement>(null);
  const [px, setPx] = useState(0);
  const [failed, setFailed] = useState(false);
  // "settle" is a moment, not a state: brighten, then rest.
  const [shown, setShown] = useState<OrbMode>(mode);
  useEffect(() => {
    setShown(mode);
    if (mode !== "settle") return;
    const t = setTimeout(() => setShown("quiet"), 1600);
    return () => clearTimeout(t);
  }, [mode]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setPx(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const moving = level === "full";
  const showShader = level !== "off" && !failed && px > 0;
  return (
    <div ref={wrap} className={`state-orb ${className}`} data-mode={shown} style={{ width: size, height: size }} aria-hidden="true">
      <motion.div
        className="absolute inset-0"
        animate={{ scale: SCALE[shown], filter: `brightness(${LIGHT[shown]})` }}
        transition={{ duration: moving ? 0.9 : 0, ease: [0.2, 0.8, 0.2, 1] }}
      >
        <div className="absolute inset-[-25%] rounded-full bg-[radial-gradient(circle,rgba(120,105,235,0.22)_30%,rgba(200,160,220,0.06)_55%,transparent_70%)] blur-xl" />
        {showShader ? (
          <div className="absolute inset-0 mix-blend-screen [mask-image:radial-gradient(circle,black_60%,transparent_71%)]">
            <div className="saturate-[0.9] sepia-[0.12] hue-rotate-[-6deg]">
              <ShaderCanvas size={px} still={level === "reduced"} speed={SPEED[shown]} onFail={() => setFailed(true)} />
            </div>
          </div>
        ) : (
          <div className="absolute inset-[6%] rounded-full bg-[radial-gradient(circle_at_50%_52%,#07060c_34%,rgba(80,110,220,0.55)_47%,rgba(150,120,230,0.4)_56%,transparent_68%)] [mask-image:radial-gradient(circle,black_60%,transparent_71%)]" />
        )}
        <div className="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(circle_at_35%_30%,rgba(240,205,150,0.18),transparent_55%),radial-gradient(circle_at_70%_75%,rgba(220,140,200,0.16),transparent_55%)] mix-blend-soft-light [mask-image:radial-gradient(circle,black_40%,transparent_70%)]" />
      </motion.div>
      {shown === "pulse" && <span className="state-orb-signal" />}
    </div>
  );
}
