// Demo Day, simulated end to end (spec §11 event-sim): 200 visitors behind one school address, each
// with their own cookie jar, in three waves over three hours of the real event plan. The offline fake
// provider answers with typical usage and scripted failures (2% rate limits, 1% timeouts); visitors
// double-click, reload and clear cookies; the ledger is unreachable for 60 seconds in the middle.
// Every demanded reading is served, spending stays under every cap, no visitor goes over quota, and
// nothing is left in flight. With maximum usage the money caps stop the evening before the call cap.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as tarotPOST } from "@/app/api/ai/tarot/route";
import { POST as chatPOST } from "@/app/api/ai/chat/route";
import { POST as natalPOST } from "@/app/api/ai/natal/route";
import { aiConfig } from "@/lib/ai/config";
import { mulberry32 } from "@/lib/tarot/rng";
import { resolvePlan } from "@/lib/ledger/plans";
import { setLedgerForTests } from "@/lib/ledger/factory";
import { LedgerUnavailable, type LedgerPort } from "@/lib/ledger/port";
import { VISITOR_COOKIE } from "@/lib/identity/visitor";
import { computeChart } from "@/lib/astro/chart";
import { natalFacts } from "@/lib/astro/natal-facts";
import { selectThemes } from "@/lib/astro/natal-themes";
import { natalRequestBody } from "@/lib/astro/natal-report";
import type { BirthData } from "@/lib/astro/birth";
import { makeClock, makeTestLedger, type TestLedger } from "./helpers/ledger";

type Route = (r: NextRequest) => Promise<Response>;
const triad = { locale: "en", spread: "triad", topic: "work", question: "Should I stay at my job?", cards: [{ id: "swords-03", reversed: true }, { id: "major-13", reversed: false }, { id: "pentacles-10", reversed: false }] };
const birth: BirthData = { date: "1999-08-14", time: "07:30", place: { name: "Boston", country: "US", lat: 42.3601, lon: -71.0589, tz: "America/New_York" } } as BirthData;
const nf = natalFacts(birth, computeChart(birth));
const NATAL = JSON.parse(JSON.stringify(natalRequestBody(nf, selectThemes(nf), "en")));
const chatBody = (i: number, turn: number) => ({ reading: triad, shown: "The cards describe a turning point at work.", messages: [{ role: "user", content: `Visitor ${i}, question ${turn}: what should I keep?` }] });

let n = 0;
const rid = () => `sim-${(++n).toString(36).padStart(14, "0")}`;

async function simulate(o: { usage: "typical" | "max"; visitors: number; outage: boolean }) {
  vi.stubEnv("AI_PROVIDER", "fake");
  vi.stubEnv("FAKE_AI_PRICE_AS", "claude-sonnet-5-5");
  vi.stubEnv("FAKE_AI_FAILURES", "rate_limited:0.02,timeout:0.01");
  vi.stubEnv("FAKE_AI_USAGE", o.usage);
  const cfg = aiConfig({ AI_PROVIDER: "fake", FAKE_AI_PRICE_AS: "claude-sonnet-5-5" });
  const plan = resolvePlan({ MOONA_PLAN: "event-2026-10-28" }, cfg);
  const clock = makeClock("2026-10-28T22:00:00Z"); // 6 pm in Boston, inside win:demo
  const t: TestLedger = await makeTestLedger({ clock, plan: null });
  await t.ledger.syncPlan(plan.sync);
  const down = (e = new LedgerUnavailable("ledger_down")): LedgerPort => ({ ...t.ledger, reserve: () => Promise.reject(e), mintVisitor: () => Promise.reject(e), complete: () => Promise.reject(e), fail: () => Promise.reject(e) });
  setLedgerForTests(t.ledger);

  const rnd = mulberry32(o.usage === "typical" ? 2026 : 1028);
  const jars = new Map<number, string>();
  const stats = { served: 0, refused: new Map<string, number>(), outage503: 0, replays: 0, calls: 0 };
  const count = (k: string) => stats.refused.set(k, (stats.refused.get(k) ?? 0) + 1);

  /** One visitor's request, retried the way the browser client does; returns the final status. */
  async function ask(v: number, route: Route, url: string, body: Record<string, unknown>): Promise<number> {
    let id = rid();
    for (let tries = 0; tries < 12; tries++) {
      if (rnd() < 0.02) jars.delete(v); // cleared cookies: a new visitor id is minted
      const send = () => route(new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify({ ...body, requestId: id }), headers: { "x-forwarded-for": "203.0.113.7", ...(jars.get(v) ? { cookie: jars.get(v)! } : {}) } }));
      const double = rnd() < 0.05;
      const [res, twin] = await Promise.all([send(), double ? send() : Promise.resolve(null)]);
      stats.calls += double ? 2 : 1;
      for (const r of [res, twin]) {
        const set = r?.headers.get("set-cookie");
        if (set?.startsWith(`${VISITOR_COOKIE}=`)) jars.set(v, set.split(";")[0]);
      }
      const json = (await res.json()) as Record<string, unknown>;
      if (twin) {
        const tj = (await twin.json()) as Record<string, unknown>;
        if (tj.replayed) stats.replays++;
      }
      if (res.status === 200) {
        if (rnd() < 0.03) {
          // a reload asks again with the same id: replayed for free
          const again = await send();
          if (((await again.json()) as { replayed?: boolean }).replayed) stats.replays++;
        }
        stats.served++;
        return 200;
      }
      const code = String(json.code);
      if (res.status === 202 || code === "busy" || code === "cooldown" || code === "subject_busy") {
        clock.advance(Number(json.retryAfterMs ?? 2000));
        continue;
      }
      if (code === "ledger") {
        stats.outage503++;
        clock.advance(5_000);
        continue;
      }
      if (res.status === 409 || res.status === 502 || res.status === 504) {
        id = rid(); // the client makes a new id after a failed or unreplayable attempt
        clock.advance(1_000);
        continue;
      }
      count(code);
      return res.status;
    }
    count("gave_up");
    return 0;
  }

  const waves = [0, 1, 2].map((w) => Array.from({ length: Math.ceil(o.visitors / 3) }, (_, k) => w * Math.ceil(o.visitors / 3) + k).filter((v) => v < o.visitors));
  let outageAt = -1;
  for (const [w, wave] of waves.entries()) {
    clock.set(new Date(Date.parse("2026-10-28T22:00:00Z") + w * 3_600_000).toISOString());
    for (const [k, v] of wave.entries()) {
      if (o.outage && w === 1 && k === 10) {
        // the database is unreachable for 60 s: requests fail closed, then recover
        outageAt = (await t.exec.query<{ n: number }>("select count(*)::int as n from moona.requests")).rows[0].n;
        setLedgerForTests(down());
        for (let s = 0; s < 3; s++) {
          const res = await tarotPOST(new NextRequest("http://localhost/api/ai/tarot", { method: "POST", body: JSON.stringify({ ...triad, requestId: rid() }), headers: { "x-forwarded-for": "203.0.113.7", ...(jars.get(v) ? { cookie: jars.get(v)! } : {}) } }));
          expect([res.status, await res.json()]).toEqual([503, { code: "ledger" }]);
          stats.outage503++;
          clock.advance(20_000);
        }
        expect((await t.exec.query<{ n: number }>("select count(*)::int as n from moona.requests")).rows[0].n).toBe(outageAt);
        setLedgerForTests(t.ledger);
      }
      await ask(v, tarotPOST, "/api/ai/tarot", triad);
      await ask(v, natalPOST, "/api/ai/natal", NATAL);
      for (let turn = 0; turn < 3; turn++) await ask(v, chatPOST, "/api/ai/chat", chatBody(v, turn));
      clock.advance(10_000);
    }
  }
  clock.advance(10 * 60_000);
  await t.ledger.reap(10_000);
  return { t, stats, plan };
}

afterEach(() => {
  setLedgerForTests(null);
  vi.unstubAllEnvs();
});

describe("Demo Day simulation", () => {
  it("serves all 1000 readings for 200 visitors on one address, within every cap", async () => {
    const { t, stats, plan } = await simulate({ usage: "typical", visitors: 200, outage: true });
    expect(stats.served).toBe(1000);
    expect([...stats.refused.entries()]).toEqual([]);
    expect(stats.outage503).toBeGreaterThan(0);
    expect(stats.replays).toBeGreaterThan(0);
    expect(await t.ledger.audit()).toEqual([]);
    const pools = (await t.exec.query<{ id: string; spent: string; held: string; cap: string; overrun: string }>("select id, spent_micro as spent, held_micro as held, cap_micro as cap, overrun_micro as overrun from moona.pools")).rows;
    for (const p of pools) expect(Number(p.spent) + Number(p.held), p.id).toBeLessThanOrEqual(Number(p.cap) + Number(p.overrun));
    expect((await t.exec.query<{ n: number }>("select count(*)::int as n from moona.requests where state = 'calling'")).rows[0].n).toBe(0);
    const demo = plan.plan.windows.find((w) => w.id === "win:demo")!;
    const over = await t.exec.query("select u.* from moona.subject_usage u join moona.free_quotas q on q.window_id = u.window_id and q.purpose = u.purpose where u.used > q.per_subject");
    expect(over.rows).toEqual([]);
    expect(demo.quotas.chat.perSubject).toBeGreaterThanOrEqual(3);
  }, 600_000);

  it("stops on money, not on the call cap, when every call costs its maximum", async () => {
    // 450 visitors at maximum cost want more than the $15 hourly slice; the call cap (2500) is never what stops them
    const { t, stats } = await simulate({ usage: "max", visitors: 450, outage: false });
    const refused = [...stats.refused.keys()];
    expect(refused.some((k) => k === "budget")).toBe(true);
    const demo = (await t.exec.query<{ calls: number; spent: string; cap: string }>("select calls_used as calls, spent_micro as spent, cap_micro as cap from moona.pools where id = 'win:demo'")).rows[0];
    expect(demo.calls).toBeLessThan(2500);
    expect(await t.ledger.audit()).toEqual([]);
    const slices = (await t.exec.query<{ id: string; spent: string; held: string; cap: string }>("select id, spent_micro as spent, held_micro as held, cap_micro as cap from moona.pools where kind = 'slice'")).rows;
    expect(slices.some((s) => Number(s.cap) - Number(s.spent) - Number(s.held) < 1_000_000)).toBe(true); // an hourly $15 slice ran dry
  }, 600_000);
});
