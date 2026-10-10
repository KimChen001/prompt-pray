// Failed operator sign-ins, counted per network. One network that keeps guessing is
// turned away for a while; there is deliberately no total cap, which would let anyone lock the whole
// team out. The map is bounded (the oldest network is dropped first) and swept at most every 30
// seconds, so a flood of made-up x-forwarded-for values can't grow it or make each request walk it.
import "server-only";

const WINDOW_MS = 10 * 60 * 1000, MAX_FAILS = 10, MAX_NETWORKS = 5000, SWEEP_MS = 30_000;
const fails = new Map<string, number[]>();
let swept = 0;

function sweep(now: number) {
  if (now - swept < SWEEP_MS) return;
  swept = now;
  for (const [k, ts] of fails) {
    const recent = ts.filter((t) => now - t < WINDOW_MS);
    if (recent.length) fails.set(k, recent);
    else fails.delete(k);
  }
}

const recentFor = (bucket: string, now: number) => (fails.get(bucket) ?? []).filter((t) => now - t < WINDOW_MS);

/** Whether this network has failed too often lately. */
export function opsThrottled(bucket: string, now = Date.now()): boolean {
  sweep(now);
  return recentFor(bucket, now).length >= MAX_FAILS;
}

export function recordOpsFailure(bucket: string, now = Date.now()): void {
  const recent = recentFor(bucket, now);
  fails.delete(bucket); // re-added as the newest
  while (fails.size >= MAX_NETWORKS) fails.delete(fails.keys().next().value as string);
  fails.set(bucket, [...recent, now]);
}

/** For tests: how many networks are tracked, and a clean start. */
export function opsThrottleSizeForTests(): number {
  return fails.size;
}
export function resetOpsThrottleForTests(): void {
  fails.clear();
  swept = 0;
}
