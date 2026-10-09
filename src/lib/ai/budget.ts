// Persistent spend/call caps for AI requests (combined review: "持久预算上限").
// A call reserves a slot before it runs and records its estimated cost after. State is a JSON file
// (default .data/ai-usage.json, git-ignored). On serverless hosts the file lives in /tmp and is NOT
// durable across instances; `durable: false` is reported so nobody mistakes it for a hard cap there.
// The provider's own dashboard spend limit remains the real backstop.
import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BudgetLimits } from "./config";

export interface UsageState {
  totalUsd: number;
  totalCalls: number;
  days: Record<string, { calls: number; usd: number }>;
}

export interface BudgetSnapshot {
  day: string;
  callsToday: number;
  usdToday: number;
  usdTotal: number;
  limits: BudgetLimits;
  durable: boolean;
}

export type BudgetDenial = "daily_calls" | "daily_usd" | "total_usd";

/** Server accounting day (UTC), independent of any user's time zone. */
export function utcDay(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}`;
}

export function usageFilePath(env: Record<string, string | undefined> = process.env): { path: string; durable: boolean } {
  if (env.AI_USAGE_FILE) return { path: env.AI_USAGE_FILE, durable: true };
  if (env.VERCEL) return { path: join("/tmp", "moona-ai-usage.json"), durable: false };
  return { path: join(process.cwd(), ".data", "ai-usage.json"), durable: true };
}

export class Budget {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: { path: string; durable: boolean }, private limits: BudgetLimits, private now: () => Date = () => new Date()) {}

  /** Serialize read-modify-write so concurrent requests can't overshoot. */
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<UsageState> {
    try {
      return JSON.parse(await readFile(this.file.path, "utf8")) as UsageState;
    } catch {
      return { totalUsd: 0, totalCalls: 0, days: {} };
    }
  }

  private async save(s: UsageState) {
    await mkdir(dirname(this.file.path), { recursive: true });
    // keep the last 60 days
    s.days = Object.fromEntries(Object.entries(s.days).sort(([a], [b]) => a.localeCompare(b)).slice(-60));
    await writeFile(this.file.path, JSON.stringify(s, null, 2));
  }

  /** Reserves one call; null when allowed, otherwise which cap was hit. */
  reserve(): Promise<BudgetDenial | null> {
    return this.lock(async () => {
      const s = await this.load();
      const day = utcDay(this.now());
      const today = s.days[day] ?? { calls: 0, usd: 0 };
      if (s.totalUsd >= this.limits.maxUsdTotal) return "total_usd";
      if (today.usd >= this.limits.maxUsdPerDay) return "daily_usd";
      if (today.calls >= this.limits.maxCallsPerDay) return "daily_calls";
      s.days[day] = { calls: today.calls + 1, usd: today.usd };
      s.totalCalls += 1;
      await this.save(s);
      return null;
    });
  }

  /** Adds the cost of a finished call (also for failed calls that were billed). */
  record(usd: number): Promise<void> {
    return this.lock(async () => {
      if (!(usd > 0)) return;
      const s = await this.load();
      const day = utcDay(this.now());
      const today = s.days[day] ?? { calls: 0, usd: 0 };
      s.days[day] = { calls: today.calls, usd: +(today.usd + usd).toFixed(6) };
      s.totalUsd = +(s.totalUsd + usd).toFixed(6);
      await this.save(s);
    });
  }

  snapshot(): Promise<BudgetSnapshot> {
    return this.lock(async () => {
      const s = await this.load();
      const day = utcDay(this.now());
      const today = s.days[day] ?? { calls: 0, usd: 0 };
      return { day, callsToday: today.calls, usdToday: +today.usd.toFixed(4), usdTotal: +s.totalUsd.toFixed(4), limits: this.limits, durable: this.file.durable };
    });
  }
}

export function costUsd(usage: { inputTokens: number; outputTokens: number }, prices: { input: number; output: number }): number {
  return (usage.inputTokens * prices.input + usage.outputTokens * prices.output) / 1_000_000;
}
