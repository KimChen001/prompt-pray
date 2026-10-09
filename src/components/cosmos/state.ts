// Shared, render-free state for the cosmos layer (ported from the team's Figma Make prototype,
// github.com/KimChen001/Moona, src/app/App.tsx). Plain objects so the animation loops can read them
// every frame without React re-renders.

/** Pointer position in viewport fractions, and its last movement. */
export const mouse = { x: 0.5, y: 0.36, vx: 0, vy: 0 };

/** A faint nebula the starfield draws wherever a whisper is surfacing. */
export const glow = { x: 0, y: 0, a: 0 };

/** Set to show the next whisper soon (e.g. from a "whisper" button). */
export const whisperNow = { fire: false };
