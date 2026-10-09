import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addDays, checkInIcs, checkInsDue, hasSimilarNote, isQuoteOf, validLocalDate, type CheckIn, type MemoryNote } from "@/lib/memory";
import { parseTarotRequest, tarotNeedsSupport, tarotPrompt } from "@/lib/ai/tarot-prompt";
import { chatNeedsSupport, chatPrompt, parseChatRequest, validateChat } from "@/lib/ai/chat-prompt";
import { resetAiLimits } from "@/lib/ai/guard";
import { POST as tarotPOST } from "@/app/api/ai/tarot/route";
import { POST as chatPOST } from "@/app/api/ai/chat/route";

const triad = { locale: "en", spread: "triad", topic: "work", question: "Should I stay at my job?", cards: [{ id: "swords-03", reversed: true }, { id: "major-13", reversed: false }, { id: "pentacles-10", reversed: false }] };
const notes = ["Weighing two job offers: stability vs. growth", "Moved to Boston in August"];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetAiLimits();
});

describe("calendar dates", () => {
  it("adds days across month, year and leap-day boundaries", () => {
    expect(addDays("2026-10-28", 3)).toBe("2026-10-31");
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-12-30", 7)).toBe("2027-01-06");
    expect(addDays("2028-02-27", 2)).toBe("2028-02-29");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09"); // US DST day: calendar math is time-zone free
  });
  it("validates calendar dates", () => {
    expect(validLocalDate("2026-10-09")).toBe(true);
    expect(validLocalDate("2026-02-30")).toBe(false);
    expect(validLocalDate("2026-10-9")).toBe(false);
  });
  it("lists due check-ins oldest first and counts upcoming ones", () => {
    const c = (id: string, dueDate: string, status: CheckIn["status"] = "open"): CheckIn => ({ id, action: id, dueDate, status, createdAt: "2026-10-01T00:00:00Z" });
    const { due, upcoming } = checkInsDue([c("a", "2026-10-09"), c("b", "2026-10-05"), c("c", "2026-10-10"), c("d", "2026-10-01", "done")], "2026-10-09");
    expect(due.map((x) => x.id)).toEqual(["b", "a"]);
    expect(upcoming).toBe(1);
  });
});

describe("calendar file", () => {
  const c: CheckIn = { id: "abc", readingId: "r1", action: "x", dueDate: "2026-10-31", status: "open", createdAt: "2026-10-09T00:00:00Z" };
  const ics = checkInIcs(c, {
    title: "MOONA check-in: Talk to Sam; then decide, calmly",
    description: "Line one\nLine two with a backslash \\ here. 回看这次解读，记下进展。回看这次解读，记下进展。回看这次解读，记下进展。",
    url: "https://example.test/tarot/r/r1",
    now: new Date("2026-10-09T12:34:56.789Z"),
  });
  const lines = ics.split("\r\n");

  it("is an all-day event on the check-in date with CRLF lines", () => {
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(lines).toContain("DTSTART;VALUE=DATE:20261031");
    expect(lines).toContain("DTEND;VALUE=DATE:20261101");
    expect(lines).toContain("DTSTAMP:20261009T123456Z");
    expect(lines).toContain("UID:abc@moona");
  });
  it("escapes text values and folds long lines without splitting characters", () => {
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("SUMMARY:MOONA check-in: Talk to Sam\\; then decide\\, calmly");
    expect(unfolded).toContain("DESCRIPTION:Line one\\nLine two with a backslash \\\\ here.");
    expect(unfolded).toContain("回看这次解读，记下进展。");
    for (const l of lines) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(lines.some((l) => l.startsWith(" "))).toBe(true);
  });
});

describe("quotes and duplicates", () => {
  it("accepts only the person's real words, ignoring case, spacing and width", () => {
    const said = ["I'm weighing two  offers: one is stable, one is a startup."];
    expect(isQuoteOf("weighing two offers", said)).toBe(true);
    expect(isQuoteOf("ＷＥＩＧＨＩＮＧ two offers", said)).toBe(true);
    expect(isQuoteOf("weighing three offers", said)).toBe(false);
    expect(isQuoteOf("one", said)).toBe(false); // too short to mean anything
    expect(isQuoteOf("我在纠结", ["其实我在纠结要不要走"])).toBe(true);
  });
  it("detects an equivalent saved note", () => {
    const n: MemoryNote = { id: "1", text: "Weighing two offers", origin: "typed", createdAt: "", confirmedAt: "", updatedAt: "" };
    expect(hasSimilarNote([n], "  weighing TWO offers ")).toBe(true);
    expect(hasSimilarNote([n], "Weighing three offers")).toBe(false);
  });
});

describe("shared notes in tarot requests", () => {
  it("parses up to 8 short notes and puts them in the prompt as possibly outdated context", () => {
    const r = parseTarotRequest({ ...triad, notes })!;
    expect(r.notes).toEqual(notes);
    const p = tarotPrompt(r);
    expect(p.user).toContain("Saved notes (confirmed by the person earlier; may be out of date):\n- Weighing two job offers");
    expect(p.system).toContain("trust the question");
    expect(tarotPrompt(parseTarotRequest(triad)!).user).not.toContain("Saved notes");
  });
  it("rejects malformed notes", () => {
    expect(parseTarotRequest({ ...triad, notes: Array.from({ length: 9 }, (_, i) => `note ${i}`) })).toBeNull();
    expect(parseTarotRequest({ ...triad, notes: ["x".repeat(201)] })).toBeNull();
    expect(parseTarotRequest({ ...triad, notes: [""] })).toBeNull();
    expect(parseTarotRequest({ ...triad, notes: [42] })).toBeNull();
    expect(parseTarotRequest({ ...triad, notes: "a note" })).toBeNull();
    expect(parseTarotRequest({ ...triad, notes: [] })!.notes).toBeUndefined();
  });
  it("treats a crisis in a shared note like a crisis in the question", () => {
    expect(tarotNeedsSupport(parseTarotRequest({ ...triad, notes: ["I want to die"] })!)).toBe(true);
    expect(chatNeedsSupport(parseChatRequest({ reading: { ...triad, notes: ["我不想活了"] }, messages: [{ role: "user", content: "hi there" }] })!)).toBe(true);
    expect(tarotNeedsSupport(parseTarotRequest({ ...triad, notes })!)).toBe(false);
  });
});

describe("memory suggestions in chat replies", () => {
  const req = parseChatRequest({
    reading: { ...triad, notes },
    messages: [
      { role: "user", content: "Honestly I'm scared of leaving the people on my team." },
      { role: "assistant", content: "Death speaks to endings you choose. You sound loyal and maybe afraid of change." },
      { role: "user", content: "I also start a part-time MBA in January." },
    ],
  })!;
  const reply = "That changes the timing: Death's ending may be about making room.";

  it("keeps a suggestion grounded in the person's own words", () => {
    const v = validateChat({ reply, remember: [{ text: "Starting a part-time MBA in January", quote: "start a part-time MBA in January" }] }, req)!;
    expect(v.reply).toBe(reply);
    expect(v.remember).toEqual({ text: "Starting a part-time MBA in January", quote: "start a part-time MBA in January" });
    // the system prompt explains what may be suggested
    expect(chatPrompt(req).system).toContain("Never infer feelings, traits or motives");
  });
  it("drops suggestions that are inferences, duplicates or unsafe, without failing the reply", () => {
    const bad = [
      { text: "Afraid of change", quote: "afraid of change" }, // the model's words, not the person's
      { text: "Weighing two job offers: stability vs. growth", quote: "scared of leaving the people on my team" }, // already saved
      { text: "x".repeat(201), quote: "start a part-time MBA" },
      { text: "Thinks about The Tower a lot", quote: "start a part-time MBA" }, // undrawn card
      { text: "Wants to die", quote: "scared of leaving" },
      { text: "Moved", quote: "Moved to Boston in August" }, // a saved note is not something said in this chat
    ];
    for (const b of bad) expect(validateChat({ reply, remember: [b] }, req)!.remember, b.text).toBeNull();
    expect(validateChat({ reply }, req)!.remember).toBeNull(); // older replies without the field still work
    expect(validateChat({ reply, remember: "yes" }, req)!.remember).toBeNull();
    // the first usable one wins
    expect(validateChat({ reply, remember: [bad[0], { text: "Team matters a lot to them", quote: "the people on my team" }] }, req)!.remember?.quote).toBe("the people on my team");
  });
});

describe("routes with notes (mocked provider)", () => {
  const upstream = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 300 } }), { status: 200 });
  const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body) });
  beforeEach(() => {
    vi.stubEnv("AI_USAGE_FILE", join(mkdtempSync(join(tmpdir(), "moona-ai-")), "u.json"));
    vi.stubEnv("AI_API_KEY", "k");
  });

  it("chat returns a validated suggestion and sends the shared notes upstream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(upstream({ reply: "That detail matters.", remember: [{ text: "Starting an MBA in January", quote: "start a part-time MBA in January" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await chatPOST(post("/api/ai/chat", { reading: { ...triad, notes }, messages: [{ role: "user", content: "I start a part-time MBA in January." }] }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.remember).toEqual({ text: "Starting an MBA in January", quote: "start a part-time MBA in January" });
    expect(fetchMock.mock.calls[0][1].body).toContain("Moved to Boston in August");
  });
  it("crisis text in a shared note never reaches the model", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await (await tarotPOST(post("/api/ai/tarot", { ...triad, notes: ["I want to die"] }))).json()).toEqual({ code: "crisis" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("device store cascade", () => {
  // A minimal browser for the "use client" store module.
  let data: Record<string, string>;
  beforeEach(() => {
    data = {};
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => data[k] ?? null,
        setItem: (k: string, v: string) => void (data[k] = v),
        removeItem: (k: string) => void delete data[k],
      },
      addEventListener() {},
      removeEventListener() {},
    });
  });

  it("deleting a reading deletes its notes and check-ins; deleting a note unshares it", async () => {
    const store = await import("@/lib/store");
    const reading = { id: "r1", kind: "reading" as const, createdAt: "", localDate: "2026-10-09", spread: "triad" as const, topic: "work" as const, cards: triad.cards, seed: "s", noteIds: ["n1", "n2"] };
    store.saveReading(reading);
    store.saveReading({ ...reading, id: "r2", noteIds: ["n1"] });
    const note = (id: string, readingId?: string): MemoryNote => ({ id, text: id, origin: readingId ? "suggested" : "typed", readingId, createdAt: "", confirmedAt: "", updatedAt: "" });
    store.saveNote(note("n1"));
    store.saveNote(note("n2", "r1"));
    store.saveCheckIn({ id: "c1", readingId: "r1", action: "a", dueDate: "2026-10-12", status: "open", createdAt: "" });
    store.saveCheckIn({ id: "c2", readingId: "r2", action: "b", dueDate: "2026-10-12", status: "open", createdAt: "" });

    store.deleteNote("n1");
    // newest first: r2 shared only n1, r1 shared n1 and n2
    expect(store.listReadings().map((r) => [r.id, r.noteIds])).toEqual([["r2", []], ["r1", ["n2"]]]);
    store.deleteReading("r1");
    expect(store.listReadings().map((r) => r.id)).toEqual(["r2"]);
    expect(store.listNotes()).toEqual([]);
    expect(store.listCheckIns().map((c) => c.id)).toEqual(["c2"]);

    // editing keeps position; the export carries notes and check-ins; "clear all" removes them
    store.saveNote(note("n3"));
    store.saveNote(note("n4"));
    store.saveNote({ ...note("n3"), text: "edited" });
    expect(store.listNotes().map((n) => n.text)).toEqual(["n4", "edited"]);
    const exported = JSON.parse(store.exportLocalData());
    expect(exported.notes).toHaveLength(2);
    expect(exported.checkIns).toHaveLength(1);
    store.clearLocalData();
    expect(store.listNotes()).toEqual([]);
    expect(store.listCheckIns()).toEqual([]);
  });
});
