// First gate for the shared ledger: real Postgres (PGlite) loads, the migrations apply once, and the
// PL/pgSQL functions run. Checksums guard the immutable schema and re-apply changed functions.
import { describe, expect, it } from "vitest";
import { pgliteExecutor, type SqlExecutor } from "@/lib/ledger/drivers";
import { migrate, readSql } from "@/lib/ledger/migrate";
import { createSqlLedger } from "@/lib/ledger/sql-ledger";
import { LEDGER_TIMEOUT, expectAudit, syncPayload, testPlan } from "./helpers/ledger";

const wrap = (exec: SqlExecutor, rewrite: (name: string, sql: string) => string): SqlExecutor => ({
  ...exec,
  query: exec.query.bind(exec),
  close: exec.close.bind(exec),
  exec: (sql: string) => exec.exec(rewrite("", sql)),
});

describe("ledger smoke (PGlite)", LEDGER_TIMEOUT, () => {
  it("applies 001, 002 and 900 once, runs plpgsql, and re-runs nothing", async () => {
    const exec = await pgliteExecutor();
    expect(await migrate(exec, { testClock: true })).toEqual(["001", "002", "900"]);
    const versions = (await exec.query<{ version: string }>("select version from moona.schema_migrations order by version")).rows.map((r) => r.version);
    expect(versions).toEqual(["001", "002", "900"]);
    expect(await migrate(exec, { testClock: true })).toEqual([]);

    const ledger = createSqlLedger(exec, { clock: () => new Date("2026-10-12T12:00:00Z") });
    // a plpgsql function under the gate lock, with the test clock honoured
    expect((await ledger.mintVisitor("net:a"))).toEqual({ ok: false, reason: "plan_unsynced" });
    await ledger.syncPlan(syncPayload(testPlan()));
    expect(await ledger.mintVisitor("net:a")).toEqual({ ok: true });
    const snap = await ledger.snapshot();
    expect(snap.kind === "sql" && snap.activeWindowId).toBe("win:t");
    const clock = await exec.query<{ t: string }>(`select moona._clock('{"now":"2026-10-12T12:00:00Z"}'::jsonb) as t`);
    expect(new Date(clock.rows[0].t).toISOString()).toBe("2026-10-12T12:00:00.000Z");
    await expectAudit(ledger);
    // a production migrate afterwards puts the real clock back, once
    expect(await migrate(exec)).toEqual(["002"]);
    expect(await migrate(exec)).toEqual([]);
    await exec.close();
  });

  it("re-applies 002 when it changes and refuses a changed 001", async () => {
    const exec = await pgliteExecutor();
    await migrate(exec);
    await exec.exec("update moona.schema_migrations set checksum = 'old' where version = '002'");
    expect(await migrate(exec)).toEqual(["002"]);
    // production 002 resets the clock; the test clock is re-applied after it
    await exec.exec("update moona.schema_migrations set checksum = 'old' where version = '002'");
    expect(await migrate(exec, { testClock: true })).toEqual(["002", "900"]);
    await exec.exec("update moona.schema_migrations set checksum = 'old' where version = '001'");
    await expect(migrate(exec)).rejects.toThrow(/001_schema.sql changed/);
    await exec.close();
  });

  it("rolls a failed migration back completely", async () => {
    const inner = await pgliteExecutor();
    const broken = wrap(inner, (_n, sql) => (sql.includes("create or replace function moona.reserve") ? sql.replace("create or replace function moona.audit", "create or replace function moona.audit_broken(") : sql));
    await expect(migrate(broken)).rejects.toThrow();
    const left = await inner.query<{ n: number }>("select count(*)::int as n from moona.schema_migrations");
    expect(left.rows[0].n).toBe(1); // 001 committed; 002 rolled back in full
    expect(await migrate(inner)).toEqual(["002"]);
    await inner.close();
  });

  it("keeps the production clock out of the function file", () => {
    expect(readSql("002_functions.sql")).toMatch(/select clock_timestamp\(\) \$\$;/);
    expect(readSql("900_test_clock.sql")).toMatch(/p->>'now'/);
  });
});
