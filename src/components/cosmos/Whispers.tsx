"use client";
// "The universe whispers", ported from the team's Figma Make prototype (Moona/src/app/App.tsx,
// Whispers): short lines surface while you drift through the stars — after enough exploring, or after
// a while of stillness — word by word out of a blur, then dissolve. Paused during a conversation.
// Added for the real site: Chinese lines (Pinyon Script has no Chinese glyphs, so Chinese uses a serif
// with the same glow), and no movement when motion is reduced.
// These are gentle ambient lines, not readings, and not the Whispers journal (树洞).
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useI18n } from "@/lib/i18n";
import { useMotionLevel } from "@/lib/motion";
import { glow, mouse, whisperNow } from "./state";

const WHISPERS = {
  en: [
    "You're allowed to go slowly.",
    "What you're waiting for is also waiting for you.",
    "Rest is not the opposite of progress.",
    "The answer is quieter than the question.",
    "You've survived every night so far.",
    "Let something be unfinished today.",
    "Soft is not the same as weak.",
    "Not every door needs to be opened tonight.",
    "You are not late. You are on your own time.",
    "Listen to the part of you that whispers.",
    "Some things bloom only in the dark.",
    "Let go a little. Then a little more.",
  ],
  zh: [
    "慢一点，也没关系。",
    "你在等的，也在等你。",
    "休息不是进步的反面。",
    "答案比问题更安静。",
    "每一个夜晚，你都走过来了。",
    "今天，允许有些事没做完。",
    "温柔不等于软弱。",
    "不是每一扇门都要今晚打开。",
    "你没有迟到，你在自己的时区里。",
    "听听你心里那个轻声说话的部分。",
    "有些花，只在黑暗里开。",
    "放下一点点，再放下一点点。",
  ],
};

export const WHISPER_STYLE = {
  // Combined: Cinzel inscription over Pinyon Script (English); a glowing serif for Chinese.
  en: "font-['Pinyon_Script'] text-[30px] leading-[1.15] lg:text-[36px] text-[#f1ecff]/85 [text-shadow:0_0_20px_rgba(190,170,255,0.5)]",
  zh: "font-['Noto_Serif_SC','Songti_SC','STSong',serif] text-[22px] leading-[1.6] tracking-[0.12em] lg:text-[26px] text-[#f1ecff]/85 [text-shadow:0_0_20px_rgba(190,170,255,0.5)]",
};

const SPOTS_WIDE = [
  { x: [0.1, 0.24], y: [0.16, 0.3] }, { x: [0.72, 0.86], y: [0.14, 0.28] },
  { x: [0.08, 0.2], y: [0.52, 0.62] }, { x: [0.76, 0.88], y: [0.5, 0.6] },
];
const SPOTS_NARROW = [{ x: [0.28, 0.72], y: [0.09, 0.12] }];
const rand = ([a, b]: number[]) => a + Math.random() * (b - a);

export function Whispers({ paused }: { paused: boolean }) {
  const { locale, m } = useI18n();
  const level = useMotionLevel();
  const [cur, setCur] = useState<{ id: number; text: string; x: number; y: number } | null>(null);
  const idx = useRef(Math.floor(Date.now() / 864e5) % WHISPERS.en.length);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const localeRef = useRef(locale);
  localeRef.current = locale;

  useEffect(() => {
    let raf = 0, travelled = 0, lx = mouse.x, ly = mouse.y;
    let nextAt = performance.now() + 7000, need = 1.4, hideAt = 0, id = 0;
    const loop = (t: number) => {
      travelled += Math.hypot(mouse.x - lx, mouse.y - ly); lx = mouse.x; ly = mouse.y;
      if (whisperNow.fire) { whisperNow.fire = false; if (hideAt) { setCur(null); hideAt = 0; } nextAt = t + 300; travelled = 99; }
      if (hideAt && t > hideAt) { setCur(null); hideAt = 0; nextAt = t + 18000 + Math.random() * 16000; travelled = 0; need = 1.2 + Math.random(); }
      // appears after enough exploring, or simply after a while of stillness
      if (!hideAt && !pausedRef.current && document.visibilityState === "visible" && t > nextAt && (travelled > need || t > nextAt + 9000)) {
        const wide = innerWidth >= 1024;
        const spots = wide ? SPOTS_WIDE : SPOTS_NARROW;
        // prefer a spot near where the cursor has been wandering
        const sp = wide
          ? [...spots].sort((p, q) => Math.hypot((p.x[0] + p.x[1]) / 2 - mouse.x, (p.y[0] + p.y[1]) / 2 - mouse.y) - Math.hypot((q.x[0] + q.x[1]) / 2 - mouse.x, (q.y[0] + q.y[1]) / 2 - mouse.y))[Math.random() < 0.7 ? 0 : 1]
          : spots[0];
        const list = WHISPERS[localeRef.current];
        setCur({ id: ++id, text: list[idx.current++ % list.length], x: rand(sp.x), y: rand(sp.y) });
        hideAt = t + 9000;
      }
      if (pausedRef.current && hideAt) hideAt = Math.min(hideAt, t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!cur) { glow.a = 0; return; }
    glow.x = cur.x; glow.y = cur.y; glow.a = 1;
  }, [cur]);

  const moving = level === "full";
  const zh = locale === "zh";
  // English surfaces word by word; Chinese phrase by phrase (split after each comma).
  const words = cur ? (zh ? cur.text.split(/(?<=，)/) : cur.text.split(" ")) : [];

  return (
    <div className="pointer-events-none fixed inset-0 z-[5]" aria-live="polite">
      <AnimatePresence>
        {cur && (
          <motion.div
            key={cur.id}
            className={`absolute w-[min(19rem,82vw)] -translate-x-1/2 -translate-y-1/2 text-center ${zh ? WHISPER_STYLE.zh : WHISPER_STYLE.en}`}
            style={{ left: `${cur.x * 100}%`, top: `${cur.y * 100}%` }}
            initial={{ y: moving ? 10 : 0 }}
            animate={{ y: moving ? -14 : 0 }}
            exit={{ opacity: 0, filter: moving ? "blur(12px)" : "none", letterSpacing: moving ? "0.12em" : undefined, transition: { duration: moving ? 2.4 : 0.6, ease: "easeIn" } }}
            transition={{ duration: moving ? 11 : 0, ease: "linear" }}
          >
            <motion.span className="mb-3 flex items-center justify-center gap-3 font-['Cinzel'] text-[10px] not-italic uppercase leading-none tracking-[0.42em] text-[#e8dcc0]/60 [text-shadow:0_0_12px_rgba(232,200,140,0.4)] lg:text-[11px]"
              initial={{ opacity: 0, letterSpacing: moving ? "0.7em" : "0.42em" }} animate={{ opacity: 1, letterSpacing: "0.42em" }} transition={{ duration: moving ? 2.4 : 0.4, ease: [0.2, 0.8, 0.2, 1] }}>
              <span className="h-px w-10 bg-gradient-to-r from-transparent to-[#e8dcc0]/80 lg:w-14" />
              {m.cosmos.whisperTitle}
              <span className="h-px w-10 bg-gradient-to-l from-transparent to-[#e8dcc0]/80 lg:w-14" />
            </motion.span>
            {words.map((w, i) => (
              <motion.span key={i} className="inline-block whitespace-pre"
                initial={{ opacity: 0, filter: moving ? "blur(10px)" : "none", y: moving ? 6 : 0 }}
                animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
                transition={{ duration: moving ? 1.8 : 0.5, delay: moving ? 0.3 + i * 0.22 : 0, ease: [0.2, 0.8, 0.2, 1] }}>
                {w}{zh ? "" : " "}
              </motion.span>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
