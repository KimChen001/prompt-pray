// How close the budget is to its limits (spec §3.3 levels), for the status route and operator views.
// The ratio is the highest (spent + held) / cap over the pools a free call draws on (ai, the active
// window, its current slice) and the reserve; "exhausted" means the next typical call no longer fits.
import type { LedgerSnapshot, PoolView } from "./port";

export type Level = "ok" | "notice" | "warn" | "critical" | "exhausted";

const used = (p: PoolView) => p.spentMicro + p.heldMicro;
const inside = (p: PoolView, t: number) => p.startsAt !== null && p.endsAt !== null && Date.parse(p.startsAt) <= t && t < Date.parse(p.endsAt);

export function budgetLevel(s: LedgerSnapshot, warnAt: [number, number, number], nextBoundMicro: number, now = new Date()): { level: Level; ratio: number; poolId: string | null } {
  let ratio = 0, poolId: string | null = null, exhausted = false;
  const consider = (id: string, use: number, cap: number, drawn: boolean) => {
    const r = cap > 0 ? use / cap : use > 0 || drawn ? 1 : 0;
    if (r > ratio || poolId === null) { ratio = Math.max(ratio, r); poolId = id; }
    if (drawn && use + nextBoundMicro > cap) exhausted = true;
  };
  if (s.kind === "file") {
    const l = s.legacy;
    consider("total", (l.usdTotal + l.reservedUsdTotal) * 1e6, l.limits.maxUsdTotal * 1e6, true);
    consider("day", (l.usdToday + l.reservedUsdToday) * 1e6, l.limits.maxUsdPerDay * 1e6, true);
    consider("calls", l.callsToday, l.limits.maxCallsPerDay, false);
    if (l.callsToday >= l.limits.maxCallsPerDay) exhausted = true;
  } else {
    const t = now.getTime();
    const ai = s.pools.find((p) => p.id === "ai");
    const win = s.pools.find((p) => p.id === s.activeWindowId);
    const slice = win ? s.pools.find((p) => p.kind === "slice" && p.parentId === win.id && inside(p, t)) : undefined;
    const reserve = s.pools.find((p) => p.id === "reserve");
    if (ai) consider(ai.id, used(ai), ai.capMicro, true);
    if (win) {
      consider(win.id, used(win), win.capMicro, true);
      if (win.callsCap !== null) {
        consider(`${win.id}:calls`, win.callsUsed, win.callsCap, false);
        if (win.callsUsed >= win.callsCap) exhausted = true;
      }
    } else exhausted = true;
    if (slice) consider(slice.id, used(slice), slice.capMicro, true);
    if (reserve) consider(reserve.id, used(reserve), reserve.capMicro, false);
  }
  ratio = Math.min(ratio, 1);
  const level: Level = exhausted ? "exhausted" : ratio >= warnAt[2] ? "critical" : ratio >= warnAt[1] ? "warn" : ratio >= warnAt[0] ? "notice" : "ok";
  return { level, ratio: Math.round(ratio * 1000) / 1000, poolId };
}
