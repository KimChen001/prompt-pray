// A whole pack purchase through the real routes, all offline (spec §11 packs.flow): fake payments,
// fake accounts, the fake model and the SQL ledger. Buy → the return page polls before the webhook
// (a verified retrieve grants) → the late webhook changes nothing → 5 credits → a pack reading with
// its 2 follow-ups → a 3rd follow-up is refused → replays are free.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as packsGET } from "@/app/api/packs/route";
import { POST as checkoutPOST } from "@/app/api/packs/checkout/route";
import { GET as orderGET } from "@/app/api/packs/orders/[id]/route";
import { POST as fakePayPOST } from "@/app/api/ops/fake-pay/route";
import { POST as tarotPOST } from "@/app/api/ai/tarot/route";
import { POST as chatPOST } from "@/app/api/ai/chat/route";
import { setLedgerForTests } from "@/lib/ledger/factory";
import { VISITOR_COOKIE } from "@/lib/identity/visitor";
import { currentPlan } from "@/lib/payments/context";
import { paymentsConfig } from "@/lib/payments/config";
import { createFakePayments, resetFakePayments } from "@/lib/payments/fake";
import { LEDGER_TIMEOUT, expectAudit, makeTestLedger, type TestLedger } from "./helpers/ledger";

const triad = { locale: "en", spread: "triad", topic: "work", question: "Should I stay at my job?", cards: [{ id: "swords-03", reversed: true }, { id: "major-13", reversed: false }, { id: "pentacles-10", reversed: false }] };
const jar = new Map<string, string>();
let t: TestLedger;

async function call(route: (r: NextRequest, ctx: never) => Promise<Response>, method: string, url: string, body?: unknown, browser = "a", ctx?: unknown) {
  const cookie = jar.get(browser);
  const req = new NextRequest(`http://localhost${url}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), headers: { "x-forwarded-for": "198.51.100.4", ...(cookie ? { cookie } : {}) } });
  const res = await route(req, ctx as never);
  const set = res.headers.get("set-cookie");
  if (set?.startsWith(`${VISITOR_COOKIE}=`)) jar.set(browser, set.split(";")[0]);
  return { status: res.status, json: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeEach(async () => {
  for (const [k, v] of Object.entries({ PAYMENTS_MODE: "fake", AUTH_PROVIDER: "fake", AI_PROVIDER: "fake", MOONA_LEDGER: "memory", MOONA_PLAN: "dev", FAKE_AI_FAILURES: "", FAKE_AI_USAGE: "typical" })) vi.stubEnv(k, v);
  jar.clear();
  resetFakePayments();
  t = await makeTestLedger({ plan: null });
  await t.ledger.syncPlan(currentPlan().sync);
  setLedgerForTests(t.ledger);
});
afterEach(() => {
  setLedgerForTests(null);
  vi.unstubAllEnvs();
});

describe("buying and using a pack, offline", LEDGER_TIMEOUT, () => {
  it("runs the whole flow and never grants twice", async () => {
    const before = await call(packsGET, "GET", "/api/packs");
    expect(before.json).toMatchObject({ payments: { state: "fake" }, sales: { open: true }, account: { signedIn: false, provider: "fake" }, product: { readings: 5, followupsPerReading: 2, excludes: ["talk", "natal"] } });

    const co = await call(checkoutPOST, "POST", "/api/packs/checkout", { productId: "tarot5", checkoutKey: "checkout-key-flow-01" });
    expect(co.status).toBe(200);
    const orderId = co.json.orderId as string;
    expect(co.json.url).toBe(`/packs/fake-checkout/${orderId}`);
    const params = { params: Promise.resolve({ id: orderId }) };
    expect((await call(orderGET, "GET", `/api/packs/orders/${orderId}`, undefined, "a", params)).json).toMatchObject({ order: { state: "pending" }, credits: 0 });

    // the provider has the payment, its webhook hasn't arrived: the poll's verified retrieve grants
    await createFakePayments(paymentsConfig({ PAYMENTS_MODE: "fake" }, { ledgerKind: "memory", authKind: "fake" }), async () => ({ status: 200, body: { outcome: "dropped" } })).deliver(orderId, "pay");
    expect((await call(orderGET, "GET", `/api/packs/orders/${orderId}`, undefined, "a", { params: Promise.resolve({ id: orderId }) })).json).toMatchObject({ order: { state: "paid" }, credits: 5 });
    // the webhook arrives late: nothing changes
    expect((await call(fakePayPOST, "POST", "/api/ops/fake-pay", { orderId, outcome: "pay", duplicate: true })).json).toEqual({ outcomes: ["already", "duplicate_event"] });
    expect((await call(packsGET, "GET", "/api/packs")).json).toMatchObject({ account: { signedIn: true }, entitlements: { credits: 5 } });

    // a pack reading, only when asked for
    const r = await call(tarotPOST, "POST", "/api/ai/tarot", { ...triad, use: "paid", requestId: "paid-reading-0000001" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ followupsLeft: 2, meta: { source: "simulated" } });
    const paidReadingId = r.json.paidReadingId as string;
    expect((await call(packsGET, "GET", "/api/packs")).json.entitlements.credits).toBe(4);
    const ask = (i: number) => call(chatPOST, "POST", "/api/ai/chat", { reading: triad, shown: "The cards describe a turning point.", messages: [{ role: "user", content: `Follow-up ${i}: what should I keep?` }], paidReadingId, requestId: `paid-followup-000000${i}` });
    expect((await ask(1)).json).toMatchObject({ followupsLeft: 1 });
    expect((await ask(2)).json).toMatchObject({ followupsLeft: 0 });
    expect(await ask(3)).toEqual({ status: 409, json: { code: "no_followups" } });
    // replays cost nothing
    expect((await call(tarotPOST, "POST", "/api/ai/tarot", { ...triad, use: "paid", requestId: "paid-reading-0000001" })).json.replayed).toBe(true);
    expect((await ask(2)).json.replayed).toBe(true);
    expect((await call(packsGET, "GET", "/api/packs")).json.entitlements.credits).toBe(4);
    // another browser has no account here, and no pack
    expect(await call(tarotPOST, "POST", "/api/ai/tarot", { ...triad, use: "paid" }, "b")).toMatchObject({ status: 402, json: { code: "no_credits" } });
    await expectAudit(t.ledger);
  });

  it("asks for an account before a pack reading when accounts are off", async () => {
    vi.stubEnv("AUTH_PROVIDER", "none");
    expect(await call(tarotPOST, "POST", "/api/ai/tarot", { ...triad, use: "paid" })).toEqual({ status: 401, json: { code: "login_required" } });
    expect(await call(checkoutPOST, "POST", "/api/packs/checkout", { productId: "tarot5", checkoutKey: "checkout-key-none-01" })).toEqual({ status: 401, json: { code: "login_required" } });
    expect((await call(packsGET, "GET", "/api/packs")).json.sales).toEqual({ open: false, reason: "login_unavailable" });
  });

  it("keeps checkout and fake payments closed when payments are off", async () => {
    vi.stubEnv("PAYMENTS_MODE", "off");
    expect((await call(checkoutPOST, "POST", "/api/packs/checkout", { productId: "tarot5", checkoutKey: "checkout-key-off-001" })).status).toBe(404);
    expect((await call(fakePayPOST, "POST", "/api/ops/fake-pay", { orderId: "00000000-0000-4000-8000-000000000000", outcome: "pay" })).status).toBe(404);
    expect((await call(packsGET, "GET", "/api/packs")).json).toMatchObject({ payments: { state: "unconfigured" }, sales: { open: false, reason: "unconfigured" } });
  });
});
