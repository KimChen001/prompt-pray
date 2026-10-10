// @vitest-environment happy-dom
// The reading page's pack choice through the real component, against a scripted server that keeps
// credits like the ledger does (one credit per new paid request id; a known id replays for free).
// Verification-workflow findings, 2026-10-10: a language switch must not use a second credit, an
// answer lost on the last credit must still be fetched, a failed attempt is offered again, and the
// follow-up composer opens as soon as a pack reading arrives.
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
import { getReading, saveReading } from "@/lib/store";
import { resetVisitorForTests } from "@/lib/ai/client";
import type { Locale } from "@/lib/tarot/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const meta = { provider: "fake", model: "simulated", generatedAt: "2026-10-12T12:00:00Z", source: "simulated" };
const tarotText = (locale: string, paid: boolean) => ({ cards: [0, 1, 2].map((position) => ({ position, insight: `[MOCK] ${locale} card ${position}` })), synthesis: `[MOCK] ${paid ? "pack" : "free"} reading in ${locale}`, action: "Write one thing down.", reflection: "What matters?", meta });
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/** A server that keeps credits like the ledger: one credit per new paid id; a known id replays. */
interface Server { freeLeft: number; credits: number; paid: Map<string, { locale: string; failed?: boolean }>; lose: number; paidPosts: string[] }
let server: Server;
let root: Root | null = null;
let container: HTMLElement;

function handle(url: string, init?: RequestInit): Response | Promise<Response> {
  if (url === "/api/ai/visitor") return new Response(null, { status: 204 });
  if (url === "/api/packs") return json(200, { payments: { state: "fake" }, sales: { open: true } });
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url === "/api/ai/tarot" && body.use === "paid") {
    server.paidPosts.push(body.requestId);
    const known = server.paid.get(body.requestId);
    if (known?.failed) return json(409, { code: "retry_new_key" });
    if (!known) {
      if (server.credits <= 0) return json(402, { code: "no_credits" });
      server.credits--;
      server.paid.set(body.requestId, { locale: body.locale });
    }
    if (server.lose > 0) { server.lose--; throw new TypeError("answer lost on the way"); }
    return json(200, { ...tarotText(body.locale, true), paidReadingId: "00000000-0000-4000-8000-0000000000aa", followupsLeft: 2, ...(known ? { replayed: true } : {}) });
  }
  if (url === "/api/ai/tarot") {
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
async function tap(label: string) {
  const b = button(label);
  if (!b) throw new Error(`no "${label}" in: ${text().slice(0, 300)}`);
  await act(async () => { b.click(); });
  await settle();
}

beforeEach(() => {
  localStorage.clear();
  resetVisitorForTests(true);
  server = { freeLeft: 0, credits: 5, paid: new Map(), lose: 0, paidPosts: [] };
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
    saveReading({ ...getReading("reading-1")!, ai: undefined, paid: { locale: "en", requestId: id, body: getReading("reading-1")!.paid!.body } });
    await open("en");
    expect(text()).toContain("Use 1 of your 5 pack readings for this spread?");
    expect(server.credits).toBe(5);
    expect(server.paidPosts.filter((p) => p !== id)).toHaveLength(0); // no new paid id without a tap
  });
});
