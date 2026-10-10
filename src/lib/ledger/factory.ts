// Which ledger this server uses (spec §3.3 factory). MOONA_LEDGER=auto picks Postgres when
// DATABASE_URL is set, refuses on a serverless host without one (a per-instance ledger is not a cap),
// and otherwise falls back to the legacy file budget for local development. PGlite and memory are
// development conveniences that migrate and sync the plan themselves; Postgres never does (the
// ledger-admin script does, with the owner URL), and a plan mismatch is only reported to operators.
import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aiConfig, type EnvLike } from "@/lib/ai/config";
import { Budget, usageFilePath } from "@/lib/ai/budget";
import { isDeployed, isServerlessHost } from "@/lib/host";
import { pgExecutor, pgliteExecutor } from "./drivers";
import { createFileLedger } from "./file-ledger";
import { migrate } from "./migrate";
import { resolvePlan } from "./plans";
import type { LedgerPort } from "./port";
import { createSqlLedger } from "./sql-ledger";
import { checkFunctionsVersion } from "./version";

export type LedgerChoice = { ok: true; ledger: LedgerPort } | { ok: false; reason: "ledger_down" | "ledger_nondurable" };
export type LedgerKind = "postgres" | "pglite" | "memory" | "file";

const g = globalThis as { __moonaLedger?: { key: string; choice: Promise<LedgerChoice> }; __moonaLedgerOverride?: LedgerPort | null; __moonaPlanWarning?: string | null };

/** The ledger kind the environment asks for, or null when no durable ledger is possible here. */
export function ledgerKind(env: EnvLike = process.env): LedgerKind | null {
  const want = (env.MOONA_LEDGER ?? "auto").toLowerCase();
  const serverless = isServerlessHost(env);
  if (want === "postgres") return env.DATABASE_URL ? "postgres" : null;
  if (want === "memory") return serverless || isDeployed(env) ? null : "memory"; // spending would reset on every restart
  if (want === "pglite" || want === "file") return serverless ? null : want;
  if (env.DATABASE_URL) return "postgres";
  return serverless ? null : "file";
}

/** Whether a shared, durable ledger would be used: the precondition for any AI call. */
export function ledgerConfigured(env: EnvLike = process.env): boolean {
  return ledgerKind(env) !== null;
}

/** Set when the database plan differs from the environment plan (shown to operators, never public). */
export function planWarning(): string | null {
  return g.__moonaPlanWarning ?? null;
}

async function open(kind: LedgerKind, env: EnvLike): Promise<LedgerChoice> {
  const cfg = aiConfig(env);
  if (kind === "file") {
    const file = usageFilePath(env);
    if (!file.durable) return { ok: false, reason: "ledger_nondurable" };
    return { ok: true, ledger: createFileLedger(new Budget(file, cfg.limits)) };
  }
  const plan = resolvePlan(env, cfg);
  if (kind === "postgres") {
    const caPath = env.DATABASE_CA_CERT;
    const exec = pgExecutor(env.DATABASE_URL!, {
      max: Number(env.DATABASE_POOL_MAX) || 2,
      queryTimeoutMs: Number(env.DATABASE_QUERY_TIMEOUT_MS) || 4000,
      ...(caPath ? { caCert: readFileSync(caPath, "utf8") } : {}),
    });
    await checkFunctionsVersion(exec); // never run against the money rules of another version
    const ledger = createSqlLedger(exec);
    void ledger.snapshot().then(
      (s) => { g.__moonaPlanWarning = s.kind === "sql" && s.planHash !== plan.hash ? `database plan ${s.planId ?? "none"}@${s.planHash ?? "none"} differs from the environment plan ${plan.plan.id}@${plan.hash}` : null; },
      () => undefined,
    );
    return { ok: true, ledger };
  }
  const exec = await pgliteExecutor(kind === "pglite" ? env.MOONA_PGLITE_DIR || join(process.cwd(), ".data", "pglite") : undefined);
  await migrate(exec);
  await checkFunctionsVersion(exec);
  const ledger = createSqlLedger(exec);
  await ledger.syncPlan(plan.sync);
  return { ok: true, ledger };
}

export function getLedger(env: EnvLike = process.env): Promise<LedgerChoice> {
  if (g.__moonaLedgerOverride) return Promise.resolve({ ok: true, ledger: g.__moonaLedgerOverride });
  const kind = ledgerKind(env);
  if (!kind) return Promise.resolve({ ok: false, reason: "ledger_nondurable" });
  const key = `${kind}|${kind === "postgres" ? env.DATABASE_URL : kind === "pglite" ? env.MOONA_PGLITE_DIR ?? "" : kind === "file" ? usageFilePath(env).path : ""}`;
  if (g.__moonaLedger?.key !== key) {
    const choice = open(kind, env).catch((e): LedgerChoice => {
      console.error("moona: ledger unavailable", (e as Error).message);
      if (g.__moonaLedger?.key === key) g.__moonaLedger = undefined; // try again on the next request
      return { ok: false, reason: "ledger_down" };
    });
    g.__moonaLedger = { key, choice };
  }
  return g.__moonaLedger!.choice;
}

export function setLedgerForTests(l: LedgerPort | null): void {
  g.__moonaLedgerOverride = l;
  g.__moonaLedger = undefined;
}
