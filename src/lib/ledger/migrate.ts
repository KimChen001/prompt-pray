// Applies the ledger SQL (spec §3.3 migrate). Never called on the request path in production: the
// ledger-admin script runs it with the owner URL. 001 (tables) and 004 (the draw key) are immutable
// once applied; 002 (functions, all "create or replace") is re-applied whenever its contents change;
// 003 (roles) only on real Postgres; 900 (test clock) only in tests, always after 002.
import "server-only";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqlExecutor } from "./drivers";

// Line endings are normalised, so a Windows checkout and a Linux deploy agree on every checksum.
const sha = (s: string) => createHash("sha256").update(s.replace(/\r\n/g, "\n")).digest("hex");

export function sqlDir(): string {
  return join(process.cwd(), "src/lib/ledger/sql");
}

export function readSql(name: string): string {
  return readFileSync(join(sqlDir(), name), "utf8");
}

async function applyInTransaction(exec: SqlExecutor, sql: string) {
  try {
    await exec.exec(`begin;\n${sql}\ncommit;`);
  } catch (e) {
    await exec.exec("rollback;").catch(() => undefined);
    throw e;
  }
}

/** Returns the migrations applied by this call. */
export async function migrate(exec: SqlExecutor, o: { testClock?: boolean; roles?: boolean } = {}): Promise<string[]> {
  await exec.exec("create schema if not exists moona; create table if not exists moona.schema_migrations (version text primary key, checksum text not null, applied_at timestamptz not null default now());");
  const applied = new Map((await exec.query<{ version: string; checksum: string }>("select version, checksum from moona.schema_migrations")).rows.map((r) => [r.version, r.checksum]));
  const done: string[] = [];
  const record = (v: string, c: string) => `insert into moona.schema_migrations (version, checksum) values ('${v}', '${c}') on conflict (version) do update set checksum = excluded.checksum, applied_at = now();`;

  const schema = readSql("001_schema.sql");
  const c1 = sha(schema);
  if (!applied.has("001")) {
    await applyInTransaction(exec, `${schema}\n${record("001", c1)}`);
    done.push("001");
  } else if (applied.get("001") !== c1) {
    throw new Error("moona: 001_schema.sql changed after it was applied; write a new migration instead");
  }

  // tables added after 001, each applied once and never changed after (write a new one instead)
  for (const [version, file] of [["004", "004_draw_key.sql"]] as const) {
    const sql = readSql(file);
    const c = sha(sql);
    if (!applied.has(version)) {
      await applyInTransaction(exec, `${sql}
${record(version, c)}`);
      done.push(version);
    } else if (applied.get(version) !== c) {
      throw new Error(`moona: ${file} changed after it was applied; write a new migration instead`);
    }
  }

  const fns = readSql("002_functions.sql");
  const c2 = sha(fns);
  // A database once migrated for tests gets the production clock back before anything else runs.
  const testClockLeft = applied.has("900") && !o.testClock;
  if (applied.get("002") !== c2 || testClockLeft) {
    const forget = testClockLeft ? "\ndelete from moona.schema_migrations where version = '900';" : "";
    await applyInTransaction(exec, `${fns}\n${record("002", c2)}${forget}`);
    done.push("002");
  }

  if (o.roles) {
    const roles = readSql("003_roles.sql");
    const c3 = sha(roles);
    // re-granted after every function change: a recreated function starts with default privileges
    if (applied.get("003") !== c3 || done.includes("002")) {
      await applyInTransaction(exec, `${roles}\n${record("003", c3)}`);
      done.push("003");
    }
  }

  // 002 resets _clock to the production version, so tests re-apply the test clock every time.
  if (o.testClock) {
    await applyInTransaction(exec, `${readSql("900_test_clock.sql")}\n${record("900", "test")}`);
    if (!applied.has("900") || done.includes("002")) done.push("900");
  }
  return done;
}
