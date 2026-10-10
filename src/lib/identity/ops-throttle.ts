// Failed operator sign-ins, counted per network. One network that keeps guessing is
// turned away for a while; there is deliberately no total cap, which would let anyone lock the whole
// team out. The map is bounded (the oldest network is dropped first) and swept at most every 30
// seconds, so a flood of made-up x-forwarded-for values can't grow it or make each request walk it.
import "server-only";

const WINDOW_MS = 10 * 60 * 1000, MAX_FAILS = 10, MAX_NETWORKS = 5000, SWEEP_MS = 30_000;
const fails = new Map<string, number[]>();
// attempts still being checked, so a burst of parallel guesses can't all pass before any is recorded
const pending = new Map<string, number>();
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

/** Starts an attempt from this network, or refuses it when the network has failed too often lately. */
export function opsBegin(bucket: string, now = Date.now()): boolean {
  sweep(now);
  const inFlight = pending.get(bucket) ?? 0;
  if (recentFor(bucket, now).length + inFlight >= MAX_FAILS) return false;
  pending.set(bucket, inFlight + 1);
  return true;
}

/** Ends an attempt started with opsBegin; a failed one is remembered. */
export function opsSettle(bucket: string, failed: boolean, now = Date.now()): void {
  const left = (pending.get(bucket) ?? 1) - 1;
  if (left > 0) pending.set(bucket, left);
  else pending.delete(bucket);
  if (failed) recordOpsFailure(bucket, now);
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
  pending.clear();
  swept = 0;
}
