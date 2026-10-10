// The version of the ledger functions (002_functions.sql) this server was built with. The database
// reports its own through moona.functions_version(); a server never runs against another version,
// because the money rules live in those functions (a deploy that skipped `npm run ledger -- migrate`
// would otherwise run new pages on old rules). The marker is a hash of the file's text with the
// marker itself blanked, so it changes whenever the functions do; tests/ledger.version.test.ts fails
// until both the file's marker and this constant are updated (it prints the new value).
import "server-only";
import { createHash } from "node:crypto";
import type { SqlExecutor } from "./drivers";

export const LEDGER_FUNCTIONS_VERSION = "ledger-fns:ee25ebaaa430";

const MARKER = /ledger-fns:[0-9a-f]{12}/;

/** The marker a functions file should carry (line endings normalised, as in migrate.ts). */
export function functionsVersionOf(sql: string): string {
  const body = sql.replace(/\r\n/g, "\n").replace(MARKER, "ledger-fns:");
  return `ledger-fns:${createHash("sha256").update(body).digest("hex").slice(0, 12)}`;
}

/** Throws unless the database runs the functions this server was built with. */
export async function checkFunctionsVersion(exec: SqlExecutor): Promise<void> {
  let have: string | null = null;
  try {
    have = (await exec.query<{ v: string }>("select moona.functions_version() as v")).rows[0]?.v ?? null;
  } catch (e) {
    // a database migrated before the marker existed has no such function
    if (!/functions_version/.test((e as Error).message ?? "")) throw e;
  }
  if (have !== LEDGER_FUNCTIONS_VERSION) {
    throw new Error(`moona: the database runs ledger functions ${have ?? "from before versioning"}, this server needs ${LEDGER_FUNCTIONS_VERSION}; run \`npm run ledger -- migrate\` with the owner URL`);
  }
}
