"use client";
// The home orb, ported from the team's Figma Make prototype (Moona/src/app/App.tsx, Orb): the Ether
// shader feathered into the sky with a violet → candle-gold → rose aura and a warm tarot tint; it
// follows the pointer slightly, and shrinks and rises once a conversation starts.
// Added for the real site: a static fallback when WebGL is unavailable or motion is off, and a still
// frame when motion is reduced. The orb is decoration: none of its layers take taps or clicks (its outer
// aura reaches past the orb and over the header on phones). Only the shader itself still sees a fine
// pointer, so it keeps following the mouse on desktop.
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useMotionLevel } from "@/lib/motion";
import { ShaderCanvas } from "./ShaderCanvas";
import { mouse } from "./state";

export function Orb({ small, max = 440 }: { small: boolean; max?: number }) {
  const [base, setBase] = useState(380);
  const [failed, setFailed] = useState(false);
  const level = useMotionLevel();
  const tilt = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const f = () => setBase(Math.round(Math.min(innerWidth * 0.8, innerHeight * 0.5, max)));
    f(); addEventListener("resize", f);
    let raf = 0; const cur = { x: 0, y: 0 };
    const loop = () => {
      cur.x += ((mouse.x - 0.5) * 18 - cur.x) * 0.04; cur.y += ((mouse.y - 0.36) * 14 - cur.y) * 0.04;
      if (tilt.current) tilt.current.style.transform = `translate(${cur.x}px, ${cur.y}px)`;
      raf = requestAnimationFrame(loop);
    };
    if (level === "full") loop();
    return () => { removeEventListener("resize", f); cancelAnimationFrame(raf); };
  }, [max, level]);

  const showShader = level !== "off" && !failed;
  return (
    <motion.div
      id="orb"
      animate={{ scale: small ? 0.55 : 1, y: small ? -60 : 0 }}
      transition={{ duration: level === "full" ? 1.2 : 0, ease: [0.2, 0.8, 0.2, 1] }}
      className="pointer-events-none relative"
      style={{ width: base, height: base }}
      aria-hidden="true"
    >
      <div ref={tilt} className="absolute inset-0">
        {/* outer aura: violet → candle gold → rose */}
        <div className="absolute inset-[-25%] rounded-full bg-[radial-gradient(circle,rgba(120,105,235,0.22)_30%,rgba(200,160,220,0.06)_55%,transparent_70%)] blur-2xl" />
        {showShader ? (
          /* shader, feathered into the sky and screened so the black hole dissolves into space */
          <div className="absolute inset-0 mix-blend-screen [mask-image:radial-gradient(circle,black_60%,transparent_71%)] [@media(pointer:fine)]:pointer-events-auto">
            <div className="saturate-[0.9] sepia-[0.12] hue-rotate-[-6deg]">
              <ShaderCanvas size={base} still={level === "reduced"} onFail={() => setFailed(true)} />
            </div>
          </div>
        ) : (
          /* static orb: the same aura and a luminous ring around a dark core */
          <div className="absolute inset-[6%] rounded-full bg-[radial-gradient(circle_at_50%_52%,#07060c_34%,rgba(80,110,220,0.55)_47%,rgba(150,120,230,0.4)_56%,transparent_68%)] [mask-image:radial-gradient(circle,black_60%,transparent_71%)]" />
        )}
        {/* warm tarot tint */}
        <div className="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(circle_at_35%_30%,rgba(240,205,150,0.18),transparent_55%),radial-gradient(circle_at_70%_75%,rgba(220,140,200,0.16),transparent_55%)] mix-blend-soft-light [mask-image:radial-gradient(circle,black_40%,transparent_70%)]" />
      </div>
    </motion.div>
  );
}
