// A maintenance pause for the shared ledger, for migrations and deploys (spec §12, ledger-admin
// `maintenance`). Closing sales alone is not enough: packs already sold can still be spent, so new pack
// readings would keep arriving. The pause also trips the breaker, which refuses every new AI reservation
// while letting requests already running settle and every saved answer replay.
//
// The state from before the pause is saved in the gate's own reasons ("maintenance:{...}"), so it lives in
// the database, not in a file someone could lose. Finishing puts back exactly that state, and only where
// the marker is still there: a breaker tripped or sales closed for another reason during the pause (an
// overrun, a pack pool that ran out) is left for an operator to review.
import "server-only";
import type { SqlExecutor } from "./drivers";
import type { LedgerPort } from "./port";
import { checkFunctionsVersion } from "./version";

const MARK = "maintenance:";

interface Saved {
  id: string;
  note: string;
  was: string;
  wasReason: string | null;
}

const encode = (s: Saved) => `${MARK}${JSON.stringify(s)}`;
function decode(reason: string | null): Saved | null {
  if (!reason?.startsWith(MARK)) return null;
  try {
    const s = JSON.parse(reason.slice(MARK.length)) as Saved;
    return typeof s.id === "string" && typeof s.was === "string" ? s : null;
  } catch {
    return null;
  }
}

async function gate(ledger: LedgerPort) {
  const snap = await ledger.snapshot();
  if (snap.kind !== "sql") throw new Error("moona: maintenance needs the SQL ledger");
  return snap.gate;
}

export interface MaintenanceStatus {
  inMaintenance: boolean;
  id: string | null;
  inflight: number;
  sales: { now: string; reason: string | null; saved: Saved | null };
  breaker: { now: string; reason: string | null; saved: Saved | null };
}

export async function maintenanceStatus(ledger: LedgerPort): Promise<MaintenanceStatus> {
  const g = await gate(ledger);
  const sales = decode(g.salesReason), breaker = decode(g.breakerReason);
  return {
    inMaintenance: !!(sales || breaker), id: breaker?.id ?? sales?.id ?? null, inflight: g.inflight,
    sales: { now: g.sales, reason: g.salesReason, saved: sales },
    breaker: { now: g.breaker, reason: g.breakerReason, saved: breaker },
  };
}

/** Saves the current state in the gate, closes sales and trips the breaker. Refuses a second pause. */
export async function maintenanceStart(ledger: LedgerPort, o: { id: string; note: string }): Promise<MaintenanceStatus> {
  const before = await maintenanceStatus(ledger);
  if (before.inMaintenance) throw new Error(`moona: already in maintenance ${before.id}; finish it first`);
  const g = await gate(ledger);
  await ledger.setFlag("sales", "closed", encode({ id: o.id, note: o.note, was: g.sales, wasReason: g.salesReason }));
  await ledger.setFlag("breaker", "tripped", encode({ id: o.id, note: o.note, was: g.breaker, wasReason: g.breakerReason }));
  return maintenanceStatus(ledger);
}

/**
 * Waits for the requests already running to settle (reaping any whose lease ran out). Resolves with the
 * number still in flight: 0 when drained, more when the time ran out.
 */
export async function maintenanceDrain(ledger: LedgerPort, o: { timeoutMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; onPoll?: (inflight: number) => void }): Promise<number> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());
  const until = now() + o.timeoutMs;
  for (;;) {
    await ledger.reap(1000);
    const { inflight } = await gate(ledger);
    o.onPoll?.(inflight);
    if (inflight === 0 || now() >= until) return inflight;
    await sleep(o.pollMs ?? 2000);
  }
}

// The functions 003_roles.sql grants to the app's role (moona_app), plus the version marker.
const APP_FUNCTIONS = ["reserve", "complete", "fail", "mint_visitor", "ensure_account", "entitlements", "view_order", "orders_to_verify", "create_order", "attach_session", "fulfil", "expire_order", "revoke_order", "reap", "purge_results", "snapshot", "audit", "set_flag", "functions_version"];

/** On Postgres with the app's role: the functions it can't run. Null where there is no such role (PGlite). */
export async function missingGrants(exec: SqlExecutor): Promise<string[] | null> {
  const role = await exec.query<{ n: number }>("select count(*)::int as n from pg_roles where rolname = 'moona_app'");
  if (!role.rows[0]?.n) return null;
  const rows = await exec.query<{ name: string }>(
    `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'moona' and p.proname = any($1::text[]) and not has_function_privilege('moona_app', p.oid, 'execute')`,
    [APP_FUNCTIONS],
  );
  const present = await exec.query<{ name: string }>(
    "select distinct p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'moona' and p.proname = any($1::text[])",
    [APP_FUNCTIONS],
  );
  const have = new Set(present.rows.map((r) => r.name));
  return [...rows.rows.map((r) => r.name), ...APP_FUNCTIONS.filter((f) => !have.has(f))];
}

export interface FinishResult {
  restored: boolean;
  problems: string[];
  notes: string[];
  status: MaintenanceStatus;
}

/**
 * Checks everything the new code needs, and only then ends the pause: the functions version, the app
 * role's grants (Postgres), an empty audit, nothing in flight, and the operator's smoke test of the new
 * deploy. Any problem keeps the pause on. Otherwise each flag goes back to its saved state, where the
 * pause's marker is still on it.
 */
export async function maintenanceFinish(ledger: LedgerPort, exec: SqlExecutor, o: { smokeOk: boolean }): Promise<FinishResult> {
  const problems: string[] = [];
  const notes: string[] = [];
  const st = await maintenanceStatus(ledger);
  if (!st.inMaintenance) return { restored: false, problems: ["not in maintenance (no saved state in the gate)"], notes, status: st };
  try {
    await checkFunctionsVersion(exec);
  } catch (e) {
    problems.push((e as Error).message);
  }
  try {
    const missing = await missingGrants(exec);
    if (missing === null) notes.push("role grants not checked: there is no moona_app role here (PGlite)");
    else if (missing.length) problems.push(`moona_app may not run: ${missing.join(", ")} (run \`npm run ledger -- migrate --roles\`)`);
  } catch (e) {
    problems.push(`role grants could not be checked: ${(e as Error).message}`);
  }
  const audit = await ledger.audit().catch((e: Error) => [{ check: "audit failed", subject: e.message, expected: 0, actual: 0 }]);
  if (audit.length) problems.push(`audit: ${audit.length} problem(s), e.g. ${audit[0].check} ${audit[0].subject}`);
  if (st.inflight > 0) problems.push(`${st.inflight} request(s) still in flight`);
  if (!o.smokeOk) problems.push("the new deploy's smoke test is not confirmed (--smoke-ok)");
  if (problems.length) return { restored: false, problems, notes, status: st };

  // breaker first, so sales never open while AI is still paused for this maintenance
  if (st.breaker.saved) {
    const s = st.breaker.saved;
    await ledger.setFlag("breaker", s.was === "tripped" ? "tripped" : "ok", s.wasReason, { keepAck: true });
    if (s.was === "tripped") notes.push(`the breaker was already tripped before the pause (${s.wasReason ?? "no reason"}): left tripped`);
  } else {
    notes.push(`the breaker was tripped for another reason during the pause (${st.breaker.reason ?? "none"}): left for review`);
  }
  if (st.sales.saved) {
    const s = st.sales.saved;
    await ledger.setFlag("sales", s.was === "closed" ? "closed" : "open", s.wasReason);
  } else {
    notes.push(`sales were changed for another reason during the pause (${st.sales.now}: ${st.sales.reason ?? "none"}): left for review`);
  }
  return { restored: true, problems, notes, status: await maintenanceStatus(ledger) };
}
