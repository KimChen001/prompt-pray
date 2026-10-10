// SQL executors for the ledger: real Postgres (pg; Supabase transaction pooler) and PGlite (real
// Postgres in WASM) for local development and offline tests. Both run the same SQL files.
import "server-only";

export interface SqlExecutor {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

type PgPool = { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>; end(): Promise<void> };
const pools = ((globalThis as { __moonaPgPools?: Map<string, PgPool> }).__moonaPgPools ??= new Map());

/** A small pg pool (cached per URL on globalThis so serverless warm starts reuse it). */
export function pgExecutor(url: string, o: { max?: number; queryTimeoutMs?: number; caCert?: string } = {}): SqlExecutor {
  const get = async (): Promise<PgPool> => {
    const hit = pools.get(url);
    if (hit) return hit;
    const { Pool } = await import("pg");
    const local = /@(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(url);
    const pool = new Pool({
      connectionString: url,
      max: o.max ?? 2,
      query_timeout: o.queryTimeoutMs ?? 4000,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      ssl: local ? false : { rejectUnauthorized: true, ...(o.caCert ? { ca: o.caCert } : {}) },
    }) as unknown as PgPool;
    pools.set(url, pool);
    return pool;
  };
  return {
    async query<R>(text: string, params?: unknown[]) {
      return (await (await get()).query(text, params)) as { rows: R[] };
    },
    async exec(sql: string) {
      await (await get()).query(sql);
    },
    async close() {
      const p = pools.get(url);
      pools.delete(url);
      await p?.end();
    },
  };
}

/** PGlite in memory (no dataDir) or on disk. Statements run one at a time (serialised). */
export async function pgliteExecutor(dataDir?: string): Promise<SqlExecutor> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  return {
    async query<R>(text: string, params?: unknown[]) {
      const r = await db.query<R>(text, params as unknown[] | undefined);
      return { rows: r.rows };
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
    async close() {
      await db.close();
    },
  };
}
