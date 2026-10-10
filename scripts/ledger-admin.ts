// Operator commands for the shared ledger (spec §12). It connects with DATABASE_OWNER_URL (scripts
// only; never set on the host), or MOONA_PGLITE_DIR for a local PGlite database. It prints counts and
// states, never keys or connection strings.
//   npm run ledger -- migrate [--roles]
//   npm run ledger -- sync-plan                 (MOONA_PLAN + overrides; records AI_PRIOR_SPEND_USD once)
//   npm run ledger -- snapshot | audit | reap | reconcile
//   npm run ledger -- record-spend --pools ai,win:testing --usd 1.25 --kind manual_spend --entry ID --note "..."
//   npm run ledger -- set-flag breaker ok|tripped --reason "..."   |   set-flag sales open|closed --reason "..."
//   npm run ledger -- revoke-mode-test --yes   (going live: release and revoke every fake and test pack)
//   npm run ledger -- maintenance start --note "migrate 004" [--wait 300]   pause for a migration or deploy
//   npm run ledger -- maintenance wait [--wait 300] | status
//   npm run ledger -- maintenance finish --smoke-ok   checks, then puts back the state from before the pause
import { aiConfig } from "@/lib/ai/config";
import { pgExecutor, pgliteExecutor, type SqlExecutor } from "@/lib/ledger/drivers";
import { migrate } from "@/lib/ledger/migrate";
import { maintenanceDrain, maintenanceFinish, maintenanceStart, maintenanceStatus } from "@/lib/ledger/maintenance";
import { checkFunctionsVersion, LEDGER_FUNCTIONS_VERSION } from "@/lib/ledger/version";
import { resolvePlan, validatePlan } from "@/lib/ledger/plans";
import { createSqlLedger } from "@/lib/ledger/sql-ledger";
import { reconcile } from "@/lib/payments/service";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name: string) => rest.includes(`--${name}`);
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};

async function connect(): Promise<{ exec: SqlExecutor; where: string }> {
  if (process.env.DATABASE_OWNER_URL) return { exec: pgExecutor(process.env.DATABASE_OWNER_URL, { max: 1, queryTimeoutMs: 30_000 }), where: "postgres (owner)" };
  if (process.env.MOONA_PGLITE_DIR) return { exec: await pgliteExecutor(process.env.MOONA_PGLITE_DIR), where: `pglite ${process.env.MOONA_PGLITE_DIR}` };
  return fail("Set DATABASE_OWNER_URL (owner role, scripts only) or MOONA_PGLITE_DIR.");
}

async function main() {
  if (!cmd) fail("commands: migrate, sync-plan, snapshot, audit, reap, reconcile, record-spend, set-flag, maintenance, revoke-mode-test");
  const { exec, where } = await connect();
  const ledger = createSqlLedger(exec);
  console.log(`ledger: ${where}`);
  try {
    // every command but migrate runs the money rules in the database: never on another version. A
    // maintenance pause starts before the migration (the database still runs the old version), and its
    // finish checks the version itself before anything is put back.
    if (cmd !== "migrate" && cmd !== "maintenance") await checkFunctionsVersion(exec);
    switch (cmd) {
      case "migrate":
        console.log(`applied: ${(await migrate(exec, { roles: has("roles") })).join(", ") || "nothing (up to date)"}`);
        await checkFunctionsVersion(exec);
        console.log(`functions: ${LEDGER_FUNCTIONS_VERSION}`);
        break;
      case "sync-plan": {
        const cfg = aiConfig();
        const r = resolvePlan(process.env, cfg);
        const v = validatePlan(r, cfg, { paymentsOn: (process.env.PAYMENTS_MODE ?? "off") !== "off" });
        for (const w of v.warnings) console.log(`warning: ${w}`);
        if (v.errors.length) fail(`plan has errors:\n  ${v.errors.join("\n  ")}`);
        await ledger.syncPlan(r.sync);
        console.log(`synced ${r.plan.id} (hash ${r.hash})`);
        if (r.priorSpendMicro > 0) {
          const entry = flag("entry") ?? "prior-spend";
          const pools = ["ai", ...(r.plan.windows.some((w) => w.id === "win:testing") ? ["win:testing"] : [r.plan.windows[0].id])];
          console.log(`prior spend $${(r.priorSpendMicro / 1e6).toFixed(2)} on ${pools.join(",")}: ${await ledger.recordSpend({ entryId: entry, pools, amountMicro: r.priorSpendMicro, kind: "prior_spend", note: "AI_PRIOR_SPEND_USD" })}`);
        }
        break;
      }
      case "snapshot":
        console.log(JSON.stringify(await ledger.snapshot(), null, 2));
        break;
      case "audit": {
        const rows = await ledger.audit();
        console.log(rows.length ? JSON.stringify(rows, null, 2) : "audit: consistent");
        process.exitCode = rows.length ? 1 : 0;
        break;
      }
      case "reap":
        console.log(`reaped ${await ledger.reap(1000)}`);
        break;
      case "reconcile": {
        const r = await reconcile(ledger, null); // the provider is asked by the app's /api/ops/reconcile
        console.log(`reaped ${r.reaped}, purged ${r.purged}, audit violations ${r.audit.length}${r.audit.length ? " (breaker tripped)" : ""}`);
        break;
      }
      case "record-spend": {
        const pools = (flag("pools") ?? "").split(",").filter(Boolean);
        const amount = Number(flag("usd"));
        const kind = flag("kind") ?? "";
        const entry = flag("entry") ?? "";
        if (!pools.length || !(amount > 0) || !["prior_spend", "manual_spend", "dispute_fee", "provider_correction"].includes(kind) || !entry) {
          fail("record-spend --pools ai,win:testing --usd N --kind prior_spend|manual_spend|dispute_fee|provider_correction --entry ID [--note TEXT]");
        }
        console.log(await ledger.recordSpend({ entryId: entry, pools, amountMicro: Math.round(amount * 1e6), kind, note: flag("note") ?? "" }));
        break;
      }
      case "set-flag": {
        const [key, value] = rest;
        const ok = (key === "breaker" && (value === "ok" || value === "tripped")) || (key === "sales" && (value === "open" || value === "closed"));
        if (!ok) fail("set-flag breaker ok|tripped --reason TEXT   |   set-flag sales open|closed --reason TEXT");
        await ledger.setFlag(key as "breaker" | "sales", value as "ok" | "tripped" | "open" | "closed", flag("reason") ?? "operator");
        console.log(`${key} = ${value}`);
        break;
      }
      case "maintenance": {
        const sub = rest[0];
        const waitMs = (Number(flag("wait")) || 300) * 1000;
        const drain = async () => {
          const left = await maintenanceDrain(ledger, { timeoutMs: waitMs, onPoll: (n) => console.log(`in flight: ${n}`) });
          console.log(left === 0 ? "drained: nothing in flight. Migrate and deploy now, then `maintenance finish --smoke-ok`." : `still ${left} in flight; run \`maintenance wait\` again`);
          if (left > 0) process.exitCode = 3;
        };
        if (sub === "start") {
          const st = await maintenanceStart(ledger, { id: new Date().toISOString(), note: flag("note") ?? "maintenance" });
          console.log(`paused (${st.id}): sales closed and the breaker tripped; saved sales=${st.sales.saved?.was}, breaker=${st.breaker.saved?.was}`);
          await drain();
        } else if (sub === "wait") {
          await drain();
        } else if (sub === "status") {
          console.log(JSON.stringify(await maintenanceStatus(ledger), null, 2));
        } else if (sub === "finish") {
          const r = await maintenanceFinish(ledger, exec, { smokeOk: has("smoke-ok") });
          for (const n of r.notes) console.log(`note: ${n}`);
          if (!r.restored) {
            for (const p of r.problems) console.error(`problem: ${p}`);
            console.error("still paused: fix the problems above, then run `maintenance finish --smoke-ok` again");
            process.exitCode = 1;
          } else {
            console.log(`resumed: sales=${r.status.sales.now}, breaker=${r.status.breaker.now}`);
          }
        } else {
          fail("maintenance start --note TEXT [--wait SECONDS] | wait [--wait SECONDS] | status | finish --smoke-ok");
        }
        break;
      }
      case "revoke-mode-test":
        if (!has("yes")) fail("This releases and revokes every fake and test pack. Run again with --yes.");
        console.log(`orders released or revoked: ${await ledger.revokeMode()}`);
        break;
      default:
        fail(`unknown command ${cmd}`);
    }
  } finally {
    await exec.close();
  }
}

main().catch((e) => {
  console.error(`failed: ${(e as Error).message}`);
  process.exit(1);
});
