// @vitest-environment happy-dom
// The reading page's pack choice through the real component, against a scripted server that keeps
// credits like the ledger does (one credit per new paid request id; a known id replays for free).
// Verification-workflow findings, 2026-10-10: a language switch must not use a second credit, an
// answer lost on the last credit must still be fetched, a failed attempt is offered again, and the
// follow-up composer opens as soon as a pack reading arrives. Third round: a pending pack request is
// kept through any refusal that doesn't prove it was never made, a follow-up sent again after a
// language switch replays rather than paying twice, and the chat closes only for a real outage.
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "reading-1" }), useSearchParams: () => new URLSearchParams("talk=1") }));
vi.mock("next/link", () => ({ default: (p: { href: string; children: ReactNode }) => createElement("a", { href: p.href }, p.children) }));
vi.mock("@/components/cosmos/StateOrb", () => ({ StateOrb: () => null }));
vi.mock("@/components/ShareImage", () => ({ ShareSheet: () => null }));
vi.mock("@/components/CheckIns", () => ({ CheckInPlanner: () => null }));

import { I18nProvider } from "@/lib/i18n";
import ReadingPage from "@/app/tarot/r/[id]/page";
import { getReading, saveNote, saveReading } from "@/lib/store";
import { resetVisitorForTests } from "@/lib/ai/client";
import type { Locale } from "@/lib/tarot/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const meta = { provider: "fake", model: "simulated", generatedAt: "2026-10-12T12:00:00Z", source: "simulated" };
const tarotText = (locale: string, paid: boolean) => ({ cards: [0, 1, 2].map((position) => ({ position, insight: `[MOCK] ${locale} card ${position}` })), synthesis: `[MOCK] ${paid ? "pack" : "free"} reading in ${locale}`, action: "Write one thing down.", reflection: "What matters?", meta, locale });
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/** A server that keeps credits like the ledger: one credit per new paid id; a known id replays. */
type Refusal = { status: number; code?: string };
interface Server {
  freeLeft: number; credits: number; paid: Map<string, { locale: string; failed?: boolean }>; lose: number; paidPosts: string[]; creating: string[]; bodies: string[];
  refuseNext?: { status: number; code: string };
  /** every AI request is refused before the ledger (an outage), or only free ones */
  outage?: Refusal; freeRefusal?: Refusal; visitorDown?: boolean;
  /** the next new pack request is recorded and charged, then its answer is lost behind this error */
  chargeThenRefuse?: Refusal;
  /** the next same-id retry of a recorded pack request is refused before the ledger (a gate in front of it) */
  gateNext?: Refusal;
  /** the next new pack tap is held on its way to the server until release() (slow, or from another tab) */
  holdNext?: boolean;
  release?: () => void;
  /** like the ledger: the live pack request for each draw (one pack reading per draw) */
  byDraw: Map<string, string>;
  followups: number; chatPaid: Map<string, string>; chatCreates: string[]; chatLose: number;
}
let server: Server;
let root: Root | null = null;
let container: HTMLElement;

const refuse = (r: Refusal) => (r.code ? json(r.status, { code: r.code }) : new Response("Bad gateway", { status: r.status }));

function handle(url: string, init?: RequestInit): Response | Promise<Response> {
  if (url === "/api/ai/visitor") return server.visitorDown ? json(503, { code: "ledger" }) : new Response(null, { status: 204 });
  if (url === "/api/packs") return json(200, { payments: { state: "fake" }, sales: { open: true } });
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (server.outage && url.startsWith("/api/ai/")) return refuse(server.outage);
  if (url === "/api/ai/chat" && body.paidReadingId) {
    // like the ledger: a known id with other context is refused unless replay-only; replay-only never creates
    const ctx = JSON.stringify([body.reading.locale, body.shown, body.messages]);
    const known = server.chatPaid.get(body.requestId);
    if (known !== undefined && known !== ctx && !body.replayOnly) return json(422, { code: "key_reused" });
    if (known === undefined) {
      if (body.replayOnly) return json(404, { code: "no_such_request" });
      if (server.followups <= 0) return json(409, { code: "no_followups" });
      server.followups--;
      server.chatCreates.push(body.requestId);
      server.chatPaid.set(body.requestId, ctx);
    }
    if (server.chatLose > 0) { server.chatLose--; throw new TypeError("reply lost on the way"); }
    return json(200, { reply: "[MOCK] pack follow-up reply", remember: null, meta, paidReadingId: "00000000-0000-4000-8000-0000000000aa", followupsLeft: server.followups });
  }
  if (url === "/api/ai/tarot" && body.use === "paid" && server.holdNext && !body.replayOnly) {
    server.holdNext = false;
    // a loss when it lands rejects this fetch, as the network would
    return new Promise<Response>((resolve) => { server.release = () => { server.release = undefined; resolve(Promise.resolve().then(() => handle(url, init))); }; });
  }
  if (url === "/api/ai/tarot" && body.use === "paid") {
    server.paidPosts.push(body.requestId);
    server.bodies.push(String(init?.body));
    if (server.gateNext && server.paid.has(body.requestId)) { const r = server.gateNext; server.gateNext = undefined; return refuse(r); }
    const known = server.paid.get(body.requestId);
    if (known?.failed) return json(409, { code: "retry_new_key" });
    // one pack reading per draw: another id for a draw already bought gets that reading back, free
    const drawn = !known && body.drawId ? server.byDraw.get(body.drawId) : undefined;
    const live = drawn ? server.paid.get(drawn) : undefined;
    if (live && !live.failed) return json(200, { ...tarotText(live.locale, true), paidReadingId: "00000000-0000-4000-8000-0000000000aa", followupsLeft: 2, replayed: true });
    if (!known) {
      if (body.replayOnly) return json(404, { code: "no_such_request" }); // replay-only never creates
      if (server.refuseNext) { const r = server.refuseNext; server.refuseNext = undefined; return json(r.status, { code: r.code }); } // refused before recording
      if (server.credits <= 0) return json(402, { code: "no_credits" });
      server.credits--;
      server.creating.push(body.requestId);
      server.paid.set(body.requestId, { locale: body.locale });
      if (body.drawId) server.byDraw.set(body.drawId, body.requestId);
      if (server.chargeThenRefuse) { const r = server.chargeThenRefuse; server.chargeThenRefuse = undefined; return refuse(r); }
    }
    if (server.lose > 0) { server.lose--; throw new TypeError("answer lost on the way"); }
    return json(200, { ...tarotText(body.locale, true), paidReadingId: "00000000-0000-4000-8000-0000000000aa", followupsLeft: 2, ...(known ? { replayed: true } : {}) });
  }
  if (url === "/api/ai/tarot") {
    if (server.freeRefusal) return refuse(server.freeRefusal);
    if (server.freeLeft > 0) { server.freeLeft--; return json(200, tarotText(body.locale, false)); }
    return json(429, { code: "quota", credits: server.credits });
  }
  return json(404, { code: "not_found" });
}

const text = () => container.textContent ?? "";
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

async function open(locale: Locale) {
  await act(async () => root?.unmount());
  root = createRoot(container);
  await act(async () => { root!.render(createElement(I18nProvider, { initialLocale: locale, children: createElement(ReadingPage) })); });
  await settle();
}
async function say(words: string) {
  const box = container.querySelector("#reading-chat") as HTMLTextAreaElement | null;
  if (!box) throw new Error(`no composer in: ${text().slice(0, 300)}`);
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setValue.call(box, words); box.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function tap(label: string) {
  const b = button(label);
  if (!b) throw new Error(`no "${label}" in: ${text().slice(0, 300)}`);
  await act(async () => { b.click(); });
  await settle();
}

beforeEach(() => {
  localStorage.clear();
  resetVisitorForTests(true);
  server = { freeLeft: 0, credits: 5, paid: new Map(), lose: 0, paidPosts: [], creating: [], bodies: [], followups: 2, chatPaid: new Map(), chatCreates: [], chatLose: 0, byDraw: new Map() };
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => handle(url, init)));
  saveReading({ id: "reading-1", kind: "reading", createdAt: "2026-10-12T12:00:00Z", localDate: "2026-10-12", spread: "triad", topic: "work", question: "Should I stay at my job?", cards: [{ id: "swords-03", reversed: true }, { id: "major-13", reversed: false }, { id: "pentacles-10", reversed: false }], seed: "s" });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

describe("pack readings on the reading page", () => {
  it("stays free by default, offers a pack only after the free readings, and pays only on the tap", async () => {
    server.freeLeft = 1;
    await open("en");
    expect(text()).toContain("[MOCK] free reading in en");
    expect(server.paidPosts).toHaveLength(0);
    expect(text()).not.toContain("Use a pack reading");
    expect(text()).toContain("Our server keeps only the reply, for 2 hours");
  });

  it("asks before using a credit, uses exactly one, and opens the follow-ups right away", async () => {
    await open("en");
    expect(text()).toContain("Use 1 of your 5 pack readings for this spread?");
    expect(server.paidPosts).toHaveLength(0); // nothing paid before the tap
    await tap("Use a pack reading");
    expect(text()).toContain("[MOCK] pack reading in en");
    expect(text()).toContain("Pack reading, 2 follow-ups included");
    expect(text()).toContain("Pack follow-ups left: 2");
    expect(container.querySelector("#reading-chat")).not.toBeNull(); // the composer is there at once
    expect(text()).toContain("A pack follow-up's reply is kept on our server for 30 days"); // what the server really keeps
    expect(text()).not.toContain("for 2 hours");
    expect(server.credits).toBe(4);
    await open("en"); // reload
    expect(server.credits).toBe(4);
    expect(text()).toContain("[MOCK] pack reading in en");
  });

  it("never uses a second credit for the same spread after a language switch", async () => {
    await open("en");
    await tap("Use a pack reading");
    await open("zh");
    expect(text()).not.toContain("使用解读包");
    expect(text()).toContain("这次抽牌的解读包解读是英文的");
    expect(text()).toContain("解读包追问剩余：2"); // follow-ups work in either language
    await open("en");
    expect(text()).toContain("Pack reading, 2 follow-ups included");
    expect(server.credits).toBe(4);
    expect(new Set(server.paidPosts).size).toBe(1);
  });

  it("still fetches an answer lost on the last credit, by replaying the same request", async () => {
    server.credits = 1;
    server.lose = 2; // the answer and its automatic retry are both lost
    await open("en");
    await tap("Use a pack reading");
    expect(server.credits).toBe(0);
    expect(text()).not.toContain("[MOCK] pack reading in en");
    await open("en"); // reload: the saved pack request is replayed, no new credit is needed
    expect(text()).toContain("[MOCK] pack reading in en");
    expect(new Set(server.paidPosts).size).toBe(1);
    expect(getReading("reading-1")?.paid?.paidReadingId).toBeTruthy();
  });

  it("offers the choice again when the saved attempt failed (its credit came back), without paying by itself", async () => {
    await open("en");
    await tap("Use a pack reading");
    const id = getReading("reading-1")!.paid!.requestId;
    // pretend that attempt failed on the server and the page never saw the answer
    server.paid.set(id, { locale: "en", failed: true });
    server.credits = 5;
    saveReading({ ...getReading("reading-1")!, ai: undefined, paid: { locale: "en", requestId: id } });
    await open("en");
    expect(text()).toContain("Use 1 of your 5 pack readings for this spread?");
    expect(server.credits).toBe(5);
    expect(server.paidPosts.filter((p) => p !== id)).toHaveLength(0); // no new paid id without a tap
  });

  it("keeps the follow-up chat open in the other language (only a real AI outage closes it)", async () => {
    await open("en");
    await tap("Use a pack reading");
    await open("zh");
    expect(text()).toContain("解读包追问剩余：2");
    expect(container.querySelector("#reading-chat")).not.toBeNull();
    expect(text()).not.toContain("继续聊需要 AI");
  });

  it("never charges a refused tap later, and never resends a withdrawn note", async () => {
    saveReading({ ...getReading("reading-1")!, noteIds: [] });
    server.refuseNext = { status: 503, code: "paused" };
    await open("en");
    await tap("Use a pack reading");
    expect(server.credits).toBe(5);
    expect(getReading("reading-1")?.paid).toBeUndefined(); // nothing pending: the server never recorded it
    await open("en"); // reload
    expect(server.creating).toHaveLength(0); // no charge without a new tap
    expect(text()).toContain("Use 1 of your 5 pack readings for this spread?");
    const stored = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!) ?? "").join(" ");
    expect(stored).toContain("reading-1");
    expect(stored).not.toMatch(/"paid":\{[^}]*"body"/); // no request text is ever stored with a pack request
  });

  it("offers the choice again when a lost request never reached the server", async () => {
    await open("en");
    // a tap whose request was lost before the server: only its id is pending
    saveReading({ ...getReading("reading-1")!, paid: { locale: "en", requestId: "never-reached-0000001" } });
    await open("en");
    expect(server.paidPosts).toContain("never-reached-0000001");
    expect(server.creating).toHaveLength(0); // the resume is replay-only
    expect(getReading("reading-1")?.paid).toBeUndefined();
    expect(text()).toContain("Use 1 of your 5 pack readings for this spread?");
    expect(server.credits).toBe(5);
  });

  it("sends replayOnly on every automatic resume, never on the tap", async () => {
    server.credits = 1;
    server.lose = 2;
    await open("en");
    await tap("Use a pack reading");
    await open("en");
    const flags = server.bodies.map((b) => JSON.parse(b).replayOnly === true);
    expect(flags[0]).toBe(false); // the tap
    expect(flags.slice(-1)[0]).toBe(true); // the resume after reload
    expect(server.bodies.every((b) => JSON.parse(b).drawId === "reading-1")).toBe(true); // every pack request names its draw
    expect(server.creating).toHaveLength(1);
  });

  it("keeps a pending pack request through an outage on the resume, then replays it for free", async () => {
    server.lose = 2; // the tap's answer and its same-id retry are both lost
    await open("en");
    await tap("Use a pack reading");
    const id = getReading("reading-1")!.paid!.requestId;
    expect(server.credits).toBe(4);
    for (const outage of [{ status: 503, code: "ledger" }, { status: 503, code: "locked" }, { status: 503, code: "unconfigured" }, { status: 500 }, { status: 502 }]) {
      server.outage = outage;
      await open("en"); // reload while the server refuses before the ledger
      expect(getReading("reading-1")?.paid).toMatchObject({ locale: "en", requestId: id });
      expect(getReading("reading-1")?.paid?.paidReadingId).toBeUndefined();
      expect(text()).toContain("Your pack reading hasn't arrived yet");
      expect(text()).not.toContain("Use a pack reading");
    }
    server.outage = undefined;
    server.visitorDown = true; // the visitor check is refused as well: nothing is even sent
    resetVisitorForTests(false);
    await open("en");
    expect(getReading("reading-1")?.paid?.requestId).toBe(id);
    server.visitorDown = false;
    await tap("Try AI again");
    expect(text()).toContain("[MOCK] pack reading in en");
    expect(server.creating).toEqual([id]); // one pack request for the spread, replayed
    expect(server.credits).toBe(4);
  });

  it("keeps a tap's request when the refusal proves nothing, and fetches it on Try again", async () => {
    server.chargeThenRefuse = { status: 503, code: "ledger" }; // reserved and charged, then the ledger looked down
    await open("en");
    await tap("Use a pack reading");
    expect(server.credits).toBe(4);
    expect(getReading("reading-1")?.paid?.requestId).toBeTruthy();
    expect(text()).toContain("Your pack reading hasn't arrived yet");
    await tap("Try AI again");
    expect(text()).toContain("[MOCK] pack reading in en");
    expect(server.creating).toHaveLength(1);
    expect(server.credits).toBe(4);
  });

  it("keeps a tap's request behind a gateway error without a code", async () => {
    server.chargeThenRefuse = { status: 504 };
    await open("en");
    await tap("Use a pack reading");
    expect(getReading("reading-1")?.paid?.requestId).toBeTruthy();
    await open("en");
    expect(text()).toContain("[MOCK] pack reading in en");
    expect(server.creating).toHaveLength(1);
    expect(server.credits).toBe(4);
  });

  it("replays a pack follow-up sent again after a language switch instead of using a second one", async () => {
    await open("en");
    await tap("Use a pack reading");
    server.chatLose = 2; // the reply and its same-id retry are lost
    await say("What should I do first?");
    await tap("Send");
    expect(server.followups).toBe(1);
    await open("zh");
    await tap("重试"); // other language, other context: the reply already paid for is fetched
    expect(text()).toContain("[MOCK] pack follow-up reply");
    expect(server.chatCreates).toHaveLength(1);
    expect(server.followups).toBe(1);
    expect(text()).toContain("解读包追问剩余：1");
  });

  it("closes the follow-up chat while AI is paused or the ledger is down, but not when only the free readings ran out", async () => {
    for (const code of ["paused", "ledger"]) {
      server.outage = { status: 503, code };
      await open("en");
      expect(container.querySelector("#reading-chat")).toBeNull();
      expect(text()).toContain("Talking it through needs AI");
    }
    server.outage = undefined;
    await open("en"); // only the free readings are used up
    expect(container.querySelector("#reading-chat")).not.toBeNull();
  });

  it("keeps the chat open when the reading budget is spent (a shorter chat reply may still fit; pack money is apart)", async () => {
    server.freeRefusal = { status: 503, code: "budget" };
    await open("en");
    expect(container.querySelector("#reading-chat")).not.toBeNull();
    server.freeRefusal = undefined;
    await open("en");
    await tap("Use a pack reading");
    server.freeRefusal = { status: 503, code: "budget" };
    await open("zh");
    expect(container.querySelector("#reading-chat")).not.toBeNull();
    expect(text()).toContain("解读包追问剩余：2");
  });

  it("keeps a tap's request when an earlier attempt may have got through, even if the last answer is a gate's refusal", async () => {
    server.lose = 1; // the tap is recorded and charged, its answer lost
    server.gateNext = { status: 401, code: "login_required" }; // the same-id retry is turned away before the ledger
    await open("en");
    await tap("Use a pack reading");
    const id = getReading("reading-1")?.paid?.requestId;
    expect(id).toBeTruthy(); // kept: the first attempt may have been recorded
    expect(server.credits).toBe(4);
    expect(text()).toContain("Your pack reading hasn't arrived yet");
    expect(text()).not.toContain("needs an account"); // not beside the pending line
    await open("en"); // the resume replays it
    expect(text()).toContain("[MOCK] pack reading in en");
    expect(server.creating).toEqual([id]);
    expect(server.credits).toBe(4);
  });

  it("keeps a tap told 'never made' while its own request may still be on its way, and replays it once it lands", async () => {
    server.holdNext = true; // the tap's request is slow to reach the server
    await open("en");
    await tap("Use a pack reading");
    const id = getReading("reading-1")?.paid?.requestId;
    expect(getReading("reading-1")?.paid?.sentAt).toBeTruthy();
    await open("en"); // another tab, or a reload: its replay-only resume overtakes the tap and is told "never made"
    expect(server.paidPosts.filter((p) => p === id)).toHaveLength(1); // only the resume has arrived
    expect(getReading("reading-1")?.paid?.requestId).toBe(id); // kept, not forgotten
    expect(text()).toContain("Your pack reading hasn't arrived yet");
    expect(text()).not.toContain("Use 1 of your");
    await act(async () => server.release!()); // the tap lands and is charged; its answer reaches the first page
    await settle();
    expect(server.credits).toBe(4);
    expect(text()).toContain("[MOCK] pack reading in en"); // saved by the tap's page, shown here at once
    expect(server.creating).toEqual([id]); // one pack request for the spread
    expect(server.credits).toBe(4);
  });

  it("fetches a slow tap's answer with Try again when the tap's own page never got it", async () => {
    server.holdNext = true;
    await open("en");
    await tap("Use a pack reading");
    const id = getReading("reading-1")?.paid?.requestId;
    await open("en"); // the resume overtakes the tap: kept
    server.lose = 2; // when the tap lands, its answer and the retry are lost (say, its tab was closed)
    await act(async () => server.release!());
    await settle();
    expect(server.credits).toBe(4);
    expect(text()).not.toContain("[MOCK] pack reading in en");
    await tap("Try AI again");
    expect(text()).toContain("[MOCK] pack reading in en");
    expect(server.creating).toEqual([id]);
    expect(server.credits).toBe(4);
  });

  it("keeps a slow tap through a clock set back a second (Codex's repro), and uses one credit", async () => {
    server.holdNext = true;
    await open("en");
    await tap("Use a pack reading");
    const id = getReading("reading-1")!.paid!.requestId;
    saveReading({ ...getReading("reading-1")!, paid: { ...getReading("reading-1")!.paid!, sentAt: new Date(Date.now() + 1000).toISOString() } });
    await open("en"); // the resume overtakes the tap and is told "never made"
    expect(getReading("reading-1")?.paid?.requestId).toBe(id); // kept: within the grace either side of now
    expect(text()).not.toContain("Use 1 of your");
    await act(async () => server.release!());
    await settle();
    expect(server.creating).toEqual([id]);
    expect(server.credits).toBe(4);
  });

  it("never uses two credits for one draw, even when the page's clock is far off and it offers the choice again", async () => {
    server.holdNext = true;
    await open("en");
    await tap("Use a pack reading");
    const first = getReading("reading-1")!.paid!.requestId;
    saveReading({ ...getReading("reading-1")!, paid: { ...getReading("reading-1")!.paid!, sentAt: new Date(Date.now() + 10 * 60_000).toISOString() } });
    await open("en"); // far outside the grace: the page forgets the tap and offers the choice again
    expect(text()).toContain("Use 1 of your 5 pack readings for this spread?");
    await tap("Use a pack reading"); // a second id for the same draw
    expect(server.credits).toBe(4);
    await act(async () => server.release!()); // the first tap lands: the server gives it the draw's reading back
    await settle();
    expect(server.creating).toHaveLength(1);
    expect(server.creating).not.toContain(first);
    expect(server.credits).toBe(4);
    expect(text()).toContain("[MOCK] pack reading in en");
  });

  it("files a draw's pack reading under the language it was bought in, when the other language gets it back", async () => {
    server.holdNext = true;
    await open("en");
    await tap("Use a pack reading"); // the English tap is on its way
    saveReading({ ...getReading("reading-1")!, paid: { ...getReading("reading-1")!.paid!, sentAt: new Date(Date.now() + 10 * 60_000).toISOString() } });
    await open("zh"); // a clock far off: the Chinese page forgets the tap and offers the choice
    expect(text()).toContain("要为这次抽牌使用 1 次解读包吗");
    server.lose = 2; // the English tap lands and is charged, but its answer never comes back
    await act(async () => server.release!());
    await settle();
    await tap("使用解读包"); // the Chinese tap gets the draw's English reading back, free
    expect(server.credits).toBe(4);
    expect(getReading("reading-1")?.ai?.en?.synthesis).toBe("[MOCK] pack reading in en");
    expect(getReading("reading-1")?.ai?.zh).toBeUndefined(); // not filed as a Chinese reading
    expect(getReading("reading-1")?.paid?.locale).toBe("en");
    expect(text()).toContain("这次抽牌的解读包解读是英文的");
  });

  it("does not treat a pending tap from the future (a clock set back) as just sent", async () => {
    await open("en");
    saveReading({ ...getReading("reading-1")!, paid: { locale: "en", requestId: "never-reached-0000003", sentAt: new Date(Date.now() + 24 * 3600_000).toISOString() } });
    await open("en");
    expect(getReading("reading-1")?.paid).toBeUndefined();
    expect(text()).toContain("Use 1 of your 5 pack readings for this spread?");
  });

  it("opens the chat again when the server answers during the grace (it was closed by an outage)", async () => {
    server.chargeThenRefuse = undefined;
    server.refuseNext = { status: 503, code: "ledger" };
    await open("en");
    await tap("Use a pack reading"); // refused by a ledger outage: the chat closes, the tap is kept
    expect(container.querySelector("#reading-chat")).toBeNull();
    await tap("Try AI again"); // the server is back and was never given the tap: "never made", within the grace
    expect(getReading("reading-1")?.paid?.requestId).toBeTruthy();
    expect(container.querySelector("#reading-chat")).not.toBeNull();
  });

  it("asks for this language's own reading again once the pack reading lands in the other language", async () => {
    server.holdNext = true;
    await open("en");
    await tap("Use a pack reading");
    await open("zh"); // the other language while the tap is on its way
    await act(async () => server.release!());
    await settle();
    expect(text()).toContain("这次抽牌的解读包解读是英文的");
    expect(text()).not.toContain("AI 暂时不可用");
    expect(server.credits).toBe(4);
  });

  it("forgets an old pending tap the server never got, and offers the choice again", async () => {
    await open("en");
    saveReading({ ...getReading("reading-1")!, paid: { locale: "en", requestId: "never-reached-0000002", sentAt: new Date(Date.now() - 10 * 60_000).toISOString() } });
    await open("en");
    expect(getReading("reading-1")?.paid).toBeUndefined();
    expect(text()).toContain("Use 1 of your 5 pack readings for this spread?");
    expect(server.creating).toHaveLength(0);
  });

  it("sends no notes when it only replays an answer", async () => {
    saveNote({ id: "note-1", text: "I start a new job in March", origin: "typed", createdAt: "2026-10-12T12:00:00Z" } as never);
    saveReading({ ...getReading("reading-1")!, noteIds: ["note-1"] });
    server.lose = 2;
    await open("en");
    await tap("Use a pack reading");
    await open("en");
    const sent = server.bodies.map((b) => JSON.parse(b) as { replayOnly?: boolean; notes: string[] });
    expect(sent.filter((b) => !b.replayOnly).every((b) => b.notes.includes("I start a new job in March"))).toBe(true); // the tap
    const replays = sent.filter((b) => b.replayOnly);
    expect(replays.length).toBeGreaterThan(0);
    expect(replays.every((b) => b.notes.length === 0)).toBe(true);
    expect(text()).toContain("[MOCK] pack reading in en");
  });

  it("offers Try again after a short outage, and the chat opens again when it works", async () => {
    server.freeLeft = 1;
    server.outage = { status: 503, code: "ledger" };
    await open("en");
    expect(container.querySelector("#reading-chat")).toBeNull();
    server.outage = undefined;
    await tap("Try AI again");
    expect(text()).toContain("[MOCK] free reading in en");
    expect(container.querySelector("#reading-chat")).not.toBeNull();
  });
});
