// Overall review §2: one message contract for every conversation, exercised end to end — at least
// ten rounds with long, valid replies through both chat routes — plus the free "Talk" contract:
// context the person chose, kinds kept apart, basis ids checked, facts not contradicted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CHAT_LIMITS, parseMessages, windowMessages } from "@/lib/chat/limits";
import { newSession, sessionTitle } from "@/lib/chat/session";
import { chartContext } from "@/lib/chat/context";
import { parseTalkRequest, talkContext, talkPrompt, validateTalk } from "@/lib/ai/talk-prompt";
import { resetAiLimits } from "@/lib/ai/guard";
import { POST as talkPOST } from "@/app/api/ai/talk/route";
import { POST as chatPOST } from "@/app/api/ai/chat/route";
import type { ChatTurn } from "@/lib/tarot/types";

const boston = { name: "Boston", country: "US", lat: 42.3601, lon: -71.0589, tz: "America/New_York" };
const turn = (role: "user" | "assistant", content: string, i: number): ChatTurn => ({ role, content, at: `t${i}` });

describe("message window", () => {
  it("never starts with a reply after trimming (the 7th-message 400)", () => {
    const turns: ChatTurn[] = [];
    for (let i = 0; i < 6; i++) turns.push(turn("user", `question ${i}`, i * 2), turn("assistant", `answer ${i}`, i * 2 + 1));
    turns.push(turn("user", "seventh", 99));
    const w = windowMessages(turns);
    expect(w[0].role).toBe("user");
    expect(w[w.length - 1]).toEqual({ role: "user", content: "seventh" });
    expect(parseMessages(w)).not.toBeNull();
  });
  it("sends back a full-length valid reply (the long-reply rejection)", () => {
    const long = "x".repeat(CHAT_LIMITS.assistantMax);
    const w = windowMessages([turn("user", "hi", 1), turn("assistant", long, 2), turn("user", "and?", 3)]);
    expect(w[1].content.length).toBe(CHAT_LIMITS.assistantMax);
    expect(parseMessages(w)).not.toBeNull();
  });
  it("merges messages sent after a failed reply into one turn", () => {
    const w = windowMessages([turn("user", "first try", 1), turn("user", "second try", 2)]);
    expect(w).toEqual([{ role: "user", content: "first try\n\nsecond try" }]);
  });
  it("keeps the newest messages within the count and size limits, for any history", () => {
    const turns: ChatTurn[] = [];
    for (let i = 0; i < 40; i++) turns.push(turn("user", "q".repeat(CHAT_LIMITS.userMax), i * 2), turn("assistant", "a".repeat(CHAT_LIMITS.assistantMax), i * 2 + 1));
    turns.push(turn("user", "latest", 999));
    const w = windowMessages(turns);
    expect(w.length).toBeLessThanOrEqual(CHAT_LIMITS.maxMessages);
    expect(w.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(CHAT_LIMITS.maxTotalChars);
    expect(parseMessages(w)).not.toBeNull();
  });
  it("titles a conversation with the person's own first line", () => {
    expect(sessionTitle("  Should I move?\nMore details")).toBe("Should I move?");
    expect(sessionTitle("a".repeat(100)).length).toBe(64);
    expect(newSession("id", "Hello", { chart: false, today: true, noteIds: [] }).turns).toHaveLength(1);
  });
});

// 24+ route calls each; under a full parallel run (PGlite workers included) they can pass 5 s.
describe("ten-plus rounds through the routes (mocked provider)", { timeout: 30_000 }, () => {
  const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 300 } }), { status: 200 });
  const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body) });
  beforeEach(() => {
    vi.stubEnv("AI_USAGE_FILE", join(mkdtempSync(join(tmpdir(), "moona-chat-")), "u.json"));
    vi.stubEnv("AI_API_KEY", "k");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetAiLimits();
  });

  async function rounds(url: string, bodyFor: (messages: unknown) => unknown, lang: "en" | "zh") {
    const turns: ChatTurn[] = [];
    // Each reply is long (close to the limit) so the history grows quickly.
    const text = (lang === "zh" ? "这是一段较长的回复，" : "This is a long, careful reply. ").repeat(lang === "zh" ? 120 : 45).slice(0, CHAT_LIMITS.assistantMax - 10);
    for (let i = 0; i < 12; i++) {
      turns.push(turn("user", lang === "zh" ? `第 ${i + 1} 个问题：我该怎么看待这件事？` : `Round ${i + 1}: how should I see this?`, i * 2));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(JSON.stringify({ reply: text, remember: [], basis: [] }))));
      const res = await (url === "/api/ai/talk" ? talkPOST : chatPOST)(post(url, bodyFor(windowMessages(turns))));
      expect(res.status, `round ${i + 1}`).toBe(200);
      const json = await res.json();
      turns.push(turn("assistant", json.reply, i * 2 + 1));
    }
    expect(turns).toHaveLength(24);
  }

  it("Talk: 12 rounds in English and in Chinese", async () => {
    for (const lang of ["en", "zh"] as const) await rounds("/api/ai/talk", (messages) => ({ locale: lang, messages }), lang);
  });
  it("Tarot follow-up: 12 rounds", async () => {
    const reading = { locale: "en", spread: "triad", topic: "work", question: "Should I stay at my job?", cards: [{ id: "swords-03", reversed: true }, { id: "major-13", reversed: false }, { id: "pentacles-10", reversed: false }] };
    await rounds("/api/ai/chat", (messages) => ({ reading, shown: "A reading.", messages }), "en");
  });
});

describe("Talk: context the person chose, kept in its kinds", () => {
  const today = new Date();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(today);
  const known = chartContext({ date: "1999-08-14", time: "07:30", place: boston }, "placidus");
  const unknown = chartContext({ date: "1999-08-23", time: null, place: boston }, "placidus");
  const base = { locale: "en", messages: [{ role: "user", content: "I keep doubting myself at work." }] };

  it("accepts chart facts (never birth details), today's date and zone, and notes", () => {
    const r = parseTalkRequest({ ...base, chart: known, today: { date, timeZone: "America/New_York" }, notes: [{ id: "n1", text: "Started a new job in May" }] })!;
    expect(r).not.toBeNull();
    const { items } = talkContext(r);
    expect(items.some((i) => i.id === "sky.moon" && i.kind === "calc")).toBe(true);
    expect(items.some((i) => i.id === "note.n1" && i.kind === "said")).toBe(true);
    const { system } = talkPrompt(r, items);
    expect(system).toContain("SAID (the person's own statements):");
    expect(system).toContain("[note.n1] Started a new job in May");
    expect(system).toContain("CALCULATED:");
    expect(JSON.stringify(r)).not.toMatch(/1999-08-14|07:30|42\.36|Boston/);
  });
  it("rejects tampered context", () => {
    expect(parseTalkRequest({ ...base, today: { date: "2001-01-01", timeZone: "America/New_York" } })).toBeNull();
    expect(parseTalkRequest({ ...base, today: { date, timeZone: "Nowhere/Land" } })).toBeNull();
    expect(parseTalkRequest({ ...base, chart: { ...unknown, facts: [...unknown.facts, { id: "angle.asc", kind: "angle", body: "asc", sign: "leo", degree: 1, timeIndependent: false }] } })).toBeNull();
    expect(parseTalkRequest({ ...base, notes: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, text: "x" })) })).toBeNull();
  });
  it("keeps only basis ids it provided, and rejects claims that contradict the chart", () => {
    const r = parseTalkRequest({ ...base, chart: known, notes: [{ id: "n1", text: "Started a new job in May" }] })!;
    const { items, claims } = talkContext(r);
    const sunId = items.find((i) => i.id.startsWith("chart.") && i.label.startsWith("Birth chart: Sun in"))!.id;
    const ok = validateTalk({ reply: "With your Sun in Leo, being seen matters to you. What would feel like enough today?", basis: [sunId, "note.n1", "made.up"], remember: [] }, r, items, claims)!;
    expect(ok.basis.map((b) => b.id)).toEqual([sunId, "note.n1"]);
    expect(ok.basis.find((b) => b.id === "note.n1")).toMatchObject({ kind: "said", label: "" }); // note text is never stored in the reply
    expect(validateTalk({ reply: "Your Sun is in Pisces, so rest.", basis: [], remember: [] }, r, items, claims)).toBeNull();
    expect(validateTalk({ reply: "Your Moon sits at 14° today.", basis: [], remember: [] }, r, items, claims)).toBeNull();
  });
  it("without a chart, invented placements are rejected; with an unknown time, both Sun signs are needed", () => {
    const none = parseTalkRequest(base)!;
    const c0 = talkContext(none);
    expect(validateTalk({ reply: "Your Moon in Scorpio feels deeply.", basis: [], remember: [] }, none, c0.items, c0.claims)).toBeNull();
    const r = parseTalkRequest({ ...base, chart: unknown })!;
    const c1 = talkContext(r);
    expect(validateTalk({ reply: "Your Sun in Leo wants to be seen.", basis: [], remember: [] }, r, c1.items, c1.claims)).toBeNull();
    expect(validateTalk({ reply: "Your Sun in Leo or Virgo may pull two ways.", basis: [], remember: [] }, r, c1.items, c1.claims)).not.toBeNull();
    expect(validateTalk({ reply: "With your Aries Rising you lead.", basis: [], remember: [] }, r, c1.items, c1.claims)).toBeNull();
  });
  it("remembers only the person's own words, never a note they already have", () => {
    const r = parseTalkRequest({ ...base, notes: [{ id: "n1", text: "Started a new job in May" }] })!;
    const { items, claims } = talkContext(r);
    expect(validateTalk({ reply: "That sounds hard.", basis: [], remember: [{ text: "Doubts self at work", quote: "I keep doubting myself at work" }] }, r, items, claims)!.remember).toEqual({ text: "Doubts self at work", quote: "I keep doubting myself at work" });
    expect(validateTalk({ reply: "That sounds hard.", basis: [], remember: [{ text: "Feels insecure", quote: "insecure deep down" }] }, r, items, claims)!.remember).toBeNull();
    expect(validateTalk({ reply: "That sounds hard.", basis: [], remember: [{ text: "Started a new job in May", quote: "doubting myself" }] }, r, items, claims)!.remember).toBeNull();
  });
});
