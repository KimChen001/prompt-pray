// The ledger on a real Postgres with real contention (spec §11 ledger.pg): skipped unless
// TEST_DATABASE_URL points at a DISPOSABLE database (its "moona" schema is dropped and rebuilt).
// 20 pool connections run 10k mixed operations in parallel; no deadlock (40P01) may occur, every cap
// holds, and the audit is empty at the end. PGlite runs one statement at a time, so only this test
// shows the row lock doing its job.
import { describe, expect, it } from "vitest";
import { pgExecutor } from "@/lib/ledger/drivers";
import { migrate } from "@/lib/ledger/migrate";
import { createSqlLedger } from "@/lib/ledger/sql-ledger";
import { mulberry32 } from "@/lib/tarot/rng";
import { M, PACK_PRODUCT, freeReq, hex, syncPayload, testPlan, visitor } from "./helpers/ledger";

const URL_ = process.env.TEST_DATABASE_URL;
const OPS = Number(process.env.TEST_DATABASE_OPS ?? 10_000);

describe.skipIf(!URL_)("ledger on real Postgres (TEST_DATABASE_URL)", () => {
  it(`keeps every invariant through ${OPS} concurrent operations`, async () => {
    const exec = pgExecutor(URL_!, { max: 20, queryTimeoutMs: 20_000 });
    await exec.exec("drop schema if exists moona cascade;");
    await migrate(exec);
    const ledger = createSqlLedger(exec);
    await ledger.syncPlan(syncPayload(testPlan({
      aiMicro: 30 * M, packsMicro: 10 * M, inflightCap: 40, subjectInflightCap: 5, product: PACK_PRODUCT,
      windows: [{ id: "win:pg", startsAt: new Date(Date.now() - 3600_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), capMicro: 15 * M, slice: { capMicro: 5 * M, seconds: 3600 }, defaultQuota: [50, 20] }],
    })));
    const visitors = Array.from({ length: 60 }, () => visitor());
    const accounts = await Promise.all([0, 1, 2, 3].map((i) => ledger.ensureAccount("pg", `acct-${i}`)));
    const errors: string[] = [];
    let done = 0;
    const worker = async (w: number) => {
      const rnd = mulberry32(1000 + w);
      while (done < OPS) {
        done++;
        try {
          const r = rnd();
          if (r < 0.7) {
            const out = await ledger.reserve(freeReq(visitors[Math.floor(rnd() * visitors.length)], { boundMicro: 20_000 + Math.floor(rnd() * 80_000), input: `i${Math.floor(rnd() * 200)}` }));
            if (out.status === "reserved") {
              if (rnd() < 0.8) await ledger.complete({ requestId: out.requestId, chargedMicro: 10_000, billing: "known", usage: null, result: { value: 1, meta: { provider: "fake", model: "simulated", generatedAt: new Date().toISOString(), source: "simulated" } }, resultTtlSeconds: 600 });
              else await ledger.fail({ requestId: out.requestId, billing: rnd() < 0.5 ? "none" : "unknown", usage: null, errorCode: "pg" });
            }
          } else if (r < 0.8) {
            const accountId = accounts[Math.floor(rnd() * accounts.length)];
            const made = await ledger.createOrder({ accountId, productId: "tarot5", mode: "fake", checkoutKey: `k${Math.floor(rnd() * 50)}` });
            if (made.status === "created") {
              await ledger.attachSession({ orderId: made.order.id, sessionId: `cs_${made.order.id}`, url: "u" });
              await ledger.fulfil({ eventId: `e_${made.order.id}`, type: "pg", orderId: made.order.id, sessionId: `cs_${made.order.id}`, paymentId: `pi_${made.order.id}`, amountCents: made.order.amountCents, currency: "usd", livemode: false, paid: true });
            }
          } else {
            const accountId = accounts[Math.floor(rnd() * accounts.length)];
            const out = await ledger.reserve({ idemKey: hex(`pg-${w}-${done}`), subjectKey: `a:${accountId}`, accountId, cacheScope: `a:${accountId}`, purpose: "tarot", mode: "paid_reading", inputHash: hex(`pgi-${w}-${done}`), boundMicro: 50_000, readingHash: hex("pg-reading") });
            if (out.status === "reserved") await ledger.complete({ requestId: out.requestId, chargedMicro: 20_000, billing: "known", usage: null, result: { value: 1, meta: { provider: "fake", model: "simulated", generatedAt: new Date().toISOString(), source: "simulated" } }, resultTtlSeconds: 600, readingHash: hex("pg-reading") });
          }
        } catch (e) {
          errors.push(`${(e as { code?: string }).code ?? ""} ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 20 }, (_, w) => worker(w)));
    expect(errors.filter((e) => e.startsWith("40P01"))).toEqual([]);
    expect(errors).toEqual([]);
    expect(await ledger.audit()).toEqual([]);
    await exec.close();
  }, 900_000);
});
