// Regressions from the third verification round of S5, 2026-10-10: the server never runs against
// another version of the ledger functions, no account is made for a free visitor where packs are
// off, and the operator sign-in throttle stays bounded. Each case failed before its fix.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as tarotPOST } from "@/app/api/ai/tarot/route";
import { GET as packsGET } from "@/app/api/packs/route";
import { POST as sessionPOST } from "@/app/api/ops/session/route";
import { setLedgerForTests } from "@/lib/ledger/factory";
import { readSql } from "@/lib/ledger/migrate";
import { checkFunctionsVersion, functionsVersionOf, LEDGER_FUNCTIONS_VERSION } from "@/lib/ledger/version";
import { opsThrottled, opsThrottleSizeForTests, recordOpsFailure, resetOpsThrottleForTests } from "@/lib/identity/ops-throttle";
import { LEDGER_TIMEOUT, makeTestLedger, row, testPlan, type TestLedger } from "./helpers/ledger";

const triad = { locale: "en", spread: "triad", topic: "work", question: "Should I stay at my job?", cards: [{ id: "swords-03", reversed: true }, { id: "major-13", reversed: false }, { id: "pentacles-10", reversed: false }] };
const post = (b: unknown, cookie?: string) => new NextRequest("http://localhost/api/ai/tarot", { method: "POST", body: JSON.stringify(b), headers: { "x-forwarded-for": "203.0.113.9", ...(cookie ? { cookie } : {}) } });
const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0];
const accounts = async (t: TestLedger) => (await row<{ n: number }>(t.exec, "select count(*)::int as n from moona.accounts")).n;

describe("the ledger functions version", LEDGER_TIMEOUT, () => {
  it("is the one the functions file carries, and the one a migrated database reports", async () => {
    const file = readSql("002_functions.sql");
    const expected = functionsVersionOf(file);
    expect(file).toContain(`'${expected}'`); // update the marker in 002_functions.sql to this value
    expect(LEDGER_FUNCTIONS_VERSION).toBe(expected); // and LEDGER_FUNCTIONS_VERSION in ledger/version.ts
    const t = await makeTestLedger();
    await expect(checkFunctionsVersion(t.exec)).resolves.toBeUndefined();
  });

  it("says how to fix a database role that may not read the version", async () => {
    const denied = { query: async () => { throw new Error("permission denied for function functions_version"); }, exec: async () => undefined, close: async () => undefined };
    await expect(checkFunctionsVersion(denied)).rejects.toThrow(/migrate --roles/);
  });

  it("stops the server on a database that runs other functions, or functions from before versioning", async () => {
    const t = await makeTestLedger();
    const restore = `create or replace function moona.functions_version() returns text language sql immutable set search_path = pg_catalog, pg_temp as $$ select '${LEDGER_FUNCTIONS_VERSION}'::text $$;`;
    try {
      await t.exec.exec("create or replace function moona.functions_version() returns text language sql immutable set search_path = pg_catalog, pg_temp as $$ select 'ledger-fns:0123456789ab'::text $$;");
      await expect(checkFunctionsVersion(t.exec)).rejects.toThrow(/npm run ledger -- migrate/);
      await t.exec.exec("drop function moona.functions_version();");
      await expect(checkFunctionsVersion(t.exec)).rejects.toThrow(/from before versioning/);
    } finally {
      await t.exec.exec(restore);
    }
    await expect(checkFunctionsVersion(t.exec)).resolves.toBeUndefined();
  });
});

describe("free visitors where packs are off", LEDGER_TIMEOUT, () => {
  let t: TestLedger;
  beforeEach(async () => {
    for (const [k, v] of Object.entries({ AI_PROVIDER: "fake", AUTH_PROVIDER: "fake", MOONA_LEDGER: "memory", FAKE_AI_FAILURES: "", FAKE_AI_USAGE: "typical" })) vi.stubEnv(k, v);
    const base = testPlan();
    t = await makeTestLedger({ plan: testPlan({ windows: [{ ...base.windows[0], quota: { tarot: [1, 10] } }] }) });
    setLedgerForTests(t.ledger);
  });
  afterEach(() => {
    setLedgerForTests(null);
    vi.unstubAllEnvs();
  });

  async function useUpFreeReadings() {
    const first = await tarotPOST(post({ ...triad, requestId: "round3-free-0000001" }));
    expect(first.status).toBe(200);
    return tarotPOST(post({ ...triad, question: "And next month?", requestId: "round3-free-0000002" }, cookieOf(first)));
  }

  it("get no account when the free readings run out (the privacy page says so)", async () => {
    vi.stubEnv("PAYMENTS_MODE", "off");
    const second = await useUpFreeReadings();
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ code: "quota", credits: null });
    expect(await accounts(t)).toBe(0);
  });

  it("get no account from opening the packs panel where packs are off", async () => {
    vi.stubEnv("PAYMENTS_MODE", "off");
    const first = await tarotPOST(post({ ...triad, requestId: "round3-free-0000003" }));
    const res = await packsGET(new NextRequest("http://localhost/api/packs", { headers: { cookie: cookieOf(first)! } }));
    expect((await res.json()).account).toMatchObject({ signedIn: false });
    expect(await accounts(t)).toBe(0);
  });

  it("are told their credits where packs are on", async () => {
    vi.stubEnv("PAYMENTS_MODE", "fake");
    const second = await useUpFreeReadings();
    expect(await second.json()).toEqual({ code: "quota", credits: 0 });
    expect(await accounts(t)).toBe(1);
  });
});

describe("operator sign-in throttle", () => {
  afterEach(() => {
    resetOpsThrottleForTests();
    vi.unstubAllEnvs();
  });

  it("limits parallel wrong guesses from one network too", async () => {
    vi.stubEnv("OPS_TOKEN", `round3-operator-${"y".repeat(16)}`);
    const guess = () => sessionPOST(new NextRequest("http://localhost/api/ops/session", { method: "POST", body: JSON.stringify({ token: "wrong" }), headers: { "x-forwarded-for": "198.51.100.7" } }));
    const codes = (await Promise.all(Array.from({ length: 30 }, guess))).map((r) => r.status);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(10);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(20);
  });

  it("turns a guessing network away, and stays bounded under made-up networks", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    for (let i = 0; i < 10; i++) recordOpsFailure("net-guessing", now + i);
    expect(opsThrottled("net-guessing", now + 20)).toBe(true);
    expect(opsThrottled("net-other", now + 20)).toBe(false); // no total cap: the rest of the team still signs in
    for (let i = 0; i < 6000; i++) recordOpsFailure(`net-${i}`, now + 100);
    expect(opsThrottleSizeForTests()).toBeLessThanOrEqual(5000);
    expect(opsThrottled("net-5999", now + 200)).toBe(false); // one failure is not a lockout
    for (let i = 0; i < 10; i++) recordOpsFailure("net-late", now + 300 + i);
    expect(opsThrottled("net-late", now + 400)).toBe(true);
    expect(opsThrottled("net-late", now + 300 + 11 * 60_000)).toBe(false); // forgotten after ten minutes
  });
});
