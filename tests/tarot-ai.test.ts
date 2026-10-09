import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DECK } from "@/lib/tarot/deck";
import { analyze, firstSentence } from "@/lib/tarot/engine";
import { mentionsUndrawnCard, parseTarotRequest, tarotPrompt, validateTarot } from "@/lib/ai/tarot-prompt";
import { chatPrompt, parseChatRequest, validateChat } from "@/lib/ai/chat-prompt";
import { resetAiLimits } from "@/lib/ai/guard";
import { POST as tarotPOST } from "@/app/api/ai/tarot/route";
import { POST as chatPOST } from "@/app/api/ai/chat/route";

// Three of Swords (reversed), Death (upright), Ten of Pentacles (upright)
const triad = { locale: "en", spread: "triad", topic: "work", question: "Should I stay at my job?", cards: [{ id: "swords-03", reversed: true }, { id: "major-13", reversed: false }, { id: "pentacles-10", reversed: false }] };
const goodOut = {
  cards: [
    { position: 0, insight: "Reversed, the Three of Swords says an old hurt is loosening its grip." },
    { position: 1, insight: "Death marks an ending that makes room for something new." },
    { position: 2, insight: "The Ten of Pentacles points to building something lasting." },
  ],
  synthesis: "Something painful is easing, a chapter closes, and longer-term security comes into view.",
  action: "Write down one thing you would keep if you left.",
  reflection: "What would staying cost you a year from now?",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetAiLimits();
});

describe("one-line card phrases (offline layer)", () => {
  it("are a real first sentence for every card, side and language", () => {
    for (const card of DECK) {
      for (const side of [card.upright, card.reversed]) {
        const en = firstSentence(side.meaning.en);
        const zh = firstSentence(side.meaning.zh);
        // short, punchy lines are intended ("Momentum has hit turbulence.")
        expect(en.length, `${card.id} en`).toBeGreaterThan(15);
        expect(en.length, `${card.id} en`).toBeLessThan(side.meaning.en.length + 1);
        expect(en, `${card.id} en`).toMatch(/[.!?]$/);
        expect(zh.length, `${card.id} zh`).toBeGreaterThan(5);
        expect(zh, `${card.id} zh`).toMatch(/[。！？]$/);
      }
    }
  });
  it("comes with an offline reflection question for every topic", () => {
    for (const topic of ["general", "love", "work", "growth"] as const) {
      const a = analyze("single", [{ id: "major-00", reversed: false }], topic);
      expect(a.reflection.en).toMatch(/\?$/);
      expect(a.reflection.zh).toMatch(/？$/);
      expect(a.perCard[0].phrase.en.length).toBeGreaterThan(10);
    }
  });
});

describe("tarot request parsing (server rebuilds cards from ids)", () => {
  it("accepts a valid request", () => {
    expect(parseTarotRequest(triad)).toMatchObject({ spread: "triad", topic: "work", cards: triad.cards });
  });
  it("rejects wrong counts, unknown or duplicate ids, bad fields", () => {
    expect(parseTarotRequest({ ...triad, cards: triad.cards.slice(0, 2) })).toBeNull();
    expect(parseTarotRequest({ ...triad, cards: [...triad.cards.slice(0, 2), { id: "major-99", reversed: false }] })).toBeNull();
    expect(parseTarotRequest({ ...triad, cards: [triad.cards[0], triad.cards[0], triad.cards[1]] })).toBeNull();
    expect(parseTarotRequest({ ...triad, question: "x".repeat(301) })).toBeNull();
    expect(parseTarotRequest({ ...triad, spread: "celtic" })).toBeNull();
    expect(parseTarotRequest({ ...triad, cards: [{ id: "swords-03", reversed: "yes" }, triad.cards[1], triad.cards[2]] })).toBeNull();
  });
  it("puts only the drawn cards, positions and orientations in the prompt", () => {
    const p = tarotPrompt(parseTarotRequest(triad)!);
    expect(p.user).toContain("Position 0 — Past: Three of Swords, reversed");
    expect(p.user).toContain("Position 1 — Present: Death, upright");
    expect(p.user).toContain("Position 2 — Future: Ten of Pentacles, upright");
    expect(p.user).toContain("Question: Should I stay at my job?");
    expect(p.user).not.toContain("The Tower");
    expect(p.user).not.toMatch(/Chart layer/);
    const zh = tarotPrompt(parseTarotRequest({ ...triad, locale: "zh", chart: { sun: "Leo", moon: "Virgo" } })!);
    expect(zh.user).toContain("宝剑三");
    expect(zh.user).toContain("Chart layer (user opted in): Sun Leo, Moon Virgo");
    expect(zh.system).toMatch(/Simplified Chinese/);
  });
});

describe("tarot output validation", () => {
  const r = parseTarotRequest(triad)!;
  it("accepts a complete, consistent reading", () => {
    expect(validateTarot(goodOut, r)).toMatchObject({ synthesis: goodOut.synthesis });
  });
  it("rejects missing or duplicate positions", () => {
    expect(validateTarot({ ...goodOut, cards: goodOut.cards.slice(0, 2) }, r)).toBeNull();
    expect(validateTarot({ ...goodOut, cards: [goodOut.cards[0], goodOut.cards[0], goodOut.cards[2]] }, r)).toBeNull();
  });
  it("rejects cards that were not drawn", () => {
    const invented = { ...goodOut, synthesis: goodOut.synthesis + " The Tower also warns of upheaval." };
    expect(validateTarot(invented, r)).toBeNull();
    expect(mentionsUndrawnCard(["宝剑七提醒你……"], r.cards.map((c) => c.id), false)).toBe("宝剑七");
    // everyday words that are also card names do not trigger false alarms
    expect(mentionsUndrawnCard(["You have the strength to choose; justice matters to you.", "你有力量面对。"], r.cards.map((c) => c.id), false)).toBeNull();
  });
  it("allows 'The Moon' as the luminary only when the chart layer is included", () => {
    const text = ["The Moon in your chart softens this."];
    expect(mentionsUndrawnCard(text, r.cards.map((c) => c.id), false)).toBe("The Moon");
    expect(mentionsUndrawnCard(text, r.cards.map((c) => c.id), true)).toBeNull();
  });
  it("rejects a flipped orientation", () => {
    const flipped = { ...goodOut, cards: [{ position: 0, insight: "Upright, the Three of Swords brings fresh heartbreak." }, ...goodOut.cards.slice(1)] };
    expect(validateTarot(flipped, r)).toBeNull();
    const wrongRev = { ...goodOut, cards: [goodOut.cards[0], { position: 1, insight: "Death reversed shows resistance." }, goodOut.cards[2]] };
    expect(validateTarot(wrongRev, r)).toBeNull();
  });
  it("rejects unsafe text", () => {
    expect(validateTarot({ ...goodOut, action: "Maybe you want to die." }, r)).toBeNull();
  });
});

describe("follow-up chat", () => {
  const body = { reading: triad, shown: goodOut.synthesis, messages: [{ role: "user", content: "Actually I'm scared of leaving my team." }] };
  it("parses and keeps the reading fixed", () => {
    const p = parseChatRequest(body)!;
    expect(p.messages).toHaveLength(1);
    const prompt = chatPrompt(p);
    expect(prompt.system).toContain("Do not draw new cards");
    expect(prompt.system).toContain("Position 1 — Present: Death, upright");
    expect(prompt.system).toContain(goodOut.synthesis);
    expect(prompt.messages[0].content).toContain("scared of leaving");
  });
  it("rejects malformed threads", () => {
    expect(parseChatRequest({ ...body, messages: [] })).toBeNull();
    expect(parseChatRequest({ ...body, messages: [{ role: "assistant", content: "hi" }] })).toBeNull();
    expect(parseChatRequest({ ...body, messages: [{ role: "user", content: "x".repeat(801) }] })).toBeNull();
    expect(parseChatRequest({ ...body, messages: Array.from({ length: 13 }, () => ({ role: "user", content: "a" })) })).toBeNull();
  });
  it("validates replies against the drawn cards", () => {
    const p = parseChatRequest(body)!;
    expect(validateChat({ reply: "You said you're scared of leaving your team; Death speaks to that ending." }, p)).not.toBeNull();
    expect(validateChat({ reply: "Let's draw The Star for hope." }, p)).toBeNull();
    expect(validateChat({ reply: "" }, p)).toBeNull();
  });
});

describe("routes (mocked provider)", () => {
  const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 300 } }), { status: 200 });
  const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body) });
  beforeEach(() => {
    vi.stubEnv("AI_USAGE_FILE", join(mkdtempSync(join(tmpdir(), "moona-ai-")), "u.json"));
    vi.stubEnv("AI_API_KEY", "k");
  });

  it("tarot: returns the validated reading with metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(JSON.stringify(goodOut))));
    const res = await tarotPOST(post("/api/ai/tarot", triad));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cards).toHaveLength(3);
    expect(json.meta).toMatchObject({ provider: "openai-compatible", model: "claude-haiku-4-5" });
  });
  it("tarot: 502 when the model invents a card, so the client keeps the offline reading", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(JSON.stringify({ ...goodOut, synthesis: "The Hermit appears too." }))));
    const res = await tarotPOST(post("/api/ai/tarot", triad));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: "bad_output" });
  });
  it("tarot and chat: crisis input never reaches the model", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await (await tarotPOST(post("/api/ai/tarot", { ...triad, question: "I want to die" }))).json()).toEqual({ code: "crisis" });
    expect(await (await chatPOST(post("/api/ai/chat", { reading: triad, messages: [{ role: "user", content: "我不想活了" }] }))).json()).toEqual({ code: "crisis" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("chat: returns a validated reply", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(JSON.stringify({ reply: "You mentioned your team. Death here is about an ending you choose." }))));
    const res = await chatPOST(post("/api/ai/chat", { reading: triad, messages: [{ role: "user", content: "I'd miss my team." }] }));
    expect(res.status).toBe(200);
    expect((await res.json()).reply).toContain("team");
  });
});
