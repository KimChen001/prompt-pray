// Persistent spend/call caps for AI requests (combined review: "持久预算上限").
// A call reserves its estimated maximum cost before it runs and settles against reported usage.
// Unknown-billing failures retain the reservation. State is a JSON file
// (default .data/ai-usage.json, git-ignored). On serverless hosts the file lives in /tmp and is NOT
// durable across instances; `durable: false` is reported so nobody mistakes it for a hard cap there.
// The provider's own dashboard spend limit remains the real backstop.
import "server-only";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { BudgetLimits } from "./config";
import { AiError } from "./types";

export interface BudgetReservation { id: string; day: string; usd: number }

export interface UsageState {
  totalUsd: number;
  totalCalls: number;
  days: Record<string, { calls: number; usd: number }>;
  reservations?: Record<string, { day: string; usd: number }>;
}

export interface BudgetSnapshot {
  day: string;
  callsToday: number;
  usdToday: number;
  usdTotal: number;
  limits: BudgetLimits;
  durable: boolean;
  reservedUsdToday: number;
  reservedUsdTotal: number;
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
    const run = this.queue.then(() => this.fileLock(fn), () => this.fileLock(fn));
    this.queue = run.catch(() => undefined);
    return run;
  }

  // An exclusive file lock also serializes independent Budget instances / Node workers.
  // A lock left by a crashed process fails closed; it is never deleted on a time heuristic.
  private async fileLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.file.path), { recursive: true });
    const lockPath = `${this.file.path}.lock`;
    for (let attempt = 0; attempt < 100; attempt++) {
      let handle;
      try { handle = await open(lockPath, "wx"); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new AiError("budget", "usage ledger unavailable");
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      try { return await fn(); }
      finally { await handle.close(); await unlink(lockPath); }
    }
    throw new AiError("budget", "usage ledger locked");
  }

  private async load(): Promise<UsageState> {
    try {
      const s = JSON.parse(await readFile(this.file.path, "utf8")) as UsageState;
      const money = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
      const calls = (v: unknown) => money(v) && Number.isSafeInteger(v);
      const object = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
      const day = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
      if (!object(s) || !money(s.totalUsd) || !calls(s.totalCalls) || !object(s.days) ||
        !Object.entries(s.days).every(([d, v]) => day(d) && object(v) && calls(v.calls) && money(v.usd)) ||
        (s.reservations !== undefined && (!object(s.reservations) || !Object.values(s.reservations).every((v) => object(v) && typeof v.day === "string" && day(v.day) && money(v.usd))))) {
        throw new Error("invalid usage ledger");
      }
      s.reservations ??= {};
      return s;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { totalUsd: 0, totalCalls: 0, days: {}, reservations: {} };
      throw new AiError("budget", "usage ledger unreadable or invalid");
    }
  }

  private async save(s: UsageState) {
    await mkdir(dirname(this.file.path), { recursive: true });
    // keep the last 60 days
    const heldDays = new Set(Object.values(s.reservations ?? {}).map((r) => r.day));
    const recentDays = new Set(Object.keys(s.days).sort().slice(-60));
    s.days = Object.fromEntries(Object.entries(s.days).filter(([day]) => recentDays.has(day) || heldDays.has(day)));
    const temporary = `${this.file.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(s, null, 2), { flag: "wx" });
      await rename(temporary, this.file.path);
    } finally { await unlink(temporary).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; }); }
  }

  /** Call-only accounting (no network request). Paid generation uses reserveRequest instead. */
  reserve(): Promise<BudgetDenial | null> {
    return this.reserveRequest(0).then((r) => typeof r === "string" ? r : null);
  }

  /** Reserve the maximum estimated request cost before starting any network operation. */
  reserveRequest(usd: number): Promise<BudgetReservation | BudgetDenial> {
    if (!Number.isFinite(usd) || usd < 0) return Promise.reject(new AiError("budget", "invalid cost estimate"));
    return this.lock(async () => {
      const s = await this.load();
      const day = utcDay(this.now());
      const today = s.days[day] ?? { calls: 0, usd: 0 };
      const held = Object.values(s.reservations ?? {});
      const total = s.totalUsd + held.reduce((sum, r) => sum + r.usd, 0);
      const daily = today.usd + held.filter((r) => r.day === day).reduce((sum, r) => sum + r.usd, 0);
      if (total >= this.limits.maxUsdTotal || total + usd > this.limits.maxUsdTotal) return "total_usd";
      if (daily >= this.limits.maxUsdPerDay || daily + usd > this.limits.maxUsdPerDay) return "daily_usd";
      if (today.calls >= this.limits.maxCallsPerDay) return "daily_calls";
      s.days[day] = { calls: today.calls + 1, usd: today.usd };
      s.totalCalls += 1;
      const reservation = { id: randomUUID(), day, usd };
      if (usd > 0) s.reservations![reservation.id] = { day, usd };
      await this.save(s);
      return reservation;
    });
  }

  /** Unknown-billing failures keep their hold. Only reported usage is settled. */
  settle(reservation: BudgetReservation, usd: number): Promise<void> {
    if (!Number.isFinite(usd) || usd < 0) return Promise.reject(new AiError("budget", "invalid reported cost"));
    return this.lock(async () => {
      const s = await this.load();
      const held = s.reservations?.[reservation.id];
      if (!held) throw new AiError("budget", "missing cost reservation");
      delete s.reservations![reservation.id];
      const today = s.days[held.day] ?? { calls: 0, usd: 0 };
      today.usd = +(today.usd + usd).toFixed(6);
      s.days[held.day] = today;
      s.totalUsd = +(s.totalUsd + usd).toFixed(6);
      await this.save(s);
    });
  }

  /** Manual/imported spend accounting. Paid requests use settle() to remove their hold. */
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
      const held = Object.values(s.reservations ?? {});
      return { day, callsToday: today.calls, usdToday: +today.usd.toFixed(4), usdTotal: +s.totalUsd.toFixed(4), limits: this.limits, durable: this.file.durable,
        reservedUsdToday: held.filter((r) => r.day === day).reduce((sum, r) => sum + r.usd, 0), reservedUsdTotal: held.reduce((sum, r) => sum + r.usd, 0) };
    });
  }
}

export function costUsd(usage: { inputTokens: number; outputTokens: number }, prices: { input: number; output: number }): number {
  return (usage.inputTokens * prices.input + usage.outputTokens * prices.output) / 1_000_000;
}
