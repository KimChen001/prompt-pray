// Overall review §4–§5: deleting must clear every copy, and a late AI response must never overwrite
// newer changes or bring back deleted data. The store runs against an in-memory localStorage here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Reading } from "@/lib/tarot/types";

class MemStorage {
  m = new Map<string, string>();
  blocked = false;
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    if (this.blocked) throw new Error("QuotaExceededError");
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

let storage: MemStorage;
async function freshStore() {
  vi.resetModules();
  storage = new MemStorage();
  vi.stubGlobal("window", { localStorage: storage, addEventListener() {}, removeEventListener() {} });
  return import("@/lib/store");
}

const reading = (id: string, extra: Partial<Reading> = {}): Reading => ({
  id, kind: "reading", createdAt: "2026-10-09T12:00:00.000Z", localDate: "2026-10-09", spread: "single", topic: "general",
  cards: [{ id: "major-17", reversed: false }], seed: "s", ...extra,
});
const aiFor = (model: string) => ({ cards: [{ position: 0, insight: "i" }], synthesis: "s", action: "a", reflection: "r", meta: { provider: "p", model, generatedAt: "2026-10-09T12:01:00.000Z" } });

describe("deleting clears every copy", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("a deleted reading can't be recreated by a late AI response", async () => {
    const s = await freshStore();
    s.saveReading(reading("r1"));
    s.deleteReading("r1");
    expect(s.patchReading("r1", (r) => ({ ...r, ai: { en: aiFor("m") } }))).toBeNull();
    expect(s.getReading("r1")).toBeNull();
    expect(storage.getItem("moona.readings.v1")).toBe("[]");
  });

  it("with storage blocked, memory copies exist only until deleted or cleared", async () => {
    const s = await freshStore();
    storage.blocked = true;
    expect(s.saveReading(reading("r1"))).toBe(false);
    expect(s.getReading("r1")).not.toBeNull(); // the result page still works in this tab
    s.saveMatch({ id: "m1", createdAt: "x", a: { fromProfile: true, name: "me" }, b: { name: "them", date: "2000-01-01", time: null, place: null } as never, result: {} as never });
    expect(s.getMatch("m1")).not.toBeNull();
    s.clearLocalData();
    expect(s.getReading("r1")).toBeNull();
    expect(s.getMatch("m1")).toBeNull();
  });

  it("removing birth details drops matches computed from them, including memory copies", async () => {
    const s = await freshStore();
    storage.blocked = true;
    s.saveMatch({ id: "fromMe", createdAt: "x", a: { fromProfile: true, name: "me" }, b: {} as never, result: {} as never });
    s.saveMatch({ id: "typed", createdAt: "x", a: { fromProfile: false, name: "a", date: "2000-01-01", time: null, place: null } as never, b: {} as never, result: {} as never });
    s.clearBirth();
    expect(s.getMatch("fromMe")).toBeNull();
    expect(s.getMatch("typed")).not.toBeNull();
  });

  it("clearing or changing birth details moves the data epoch (async results are dropped)", async () => {
    const s = await freshStore();
    const e0 = s.dataEpoch();
    s.saveBirth({ date: "2000-01-01", time: null, place: { name: "x", country: "US", lat: 0, lon: 0, tz: "UTC" } });
    const e1 = s.dataEpoch();
    s.clearBirth();
    const e2 = s.dataEpoch();
    s.clearLocalData();
    expect(new Set([e0, e1, e2, s.dataEpoch()]).size).toBe(4);
  });

  it("deleting a note removes it from readings and conversations; deleting a conversation deletes its notes", async () => {
    const s = await freshStore();
    const now = "2026-10-09T12:00:00.000Z";
    s.saveNote({ id: "n1", text: "Weighing two offers", origin: "typed", createdAt: now, confirmedAt: now, updatedAt: now });
    s.saveNote({ id: "n2", text: "Moved to Boston", origin: "suggested", quote: "I moved to Boston", chatId: "c1", createdAt: now, confirmedAt: now, updatedAt: now });
    s.saveReading(reading("r1", { noteIds: ["n1"] }));
    s.createChat({ id: "c1", createdAt: now, updatedAt: now, title: "t", context: { chart: true, today: true, noteIds: ["n1", "n2"] }, turns: [] });
    s.deleteNote("n1");
    expect(s.getReading("r1")!.noteIds).toEqual([]);
    expect(s.getChat("c1")!.context.noteIds).toEqual(["n2"]);
    s.deleteChat("c1");
    expect(s.listNotes().map((n) => n.id)).toEqual([]);
  });

  it("removing birth details takes the chart out of every conversation's context", async () => {
    const s = await freshStore();
    const now = "2026-10-09T12:00:00.000Z";
    s.createChat({ id: "c1", createdAt: now, updatedAt: now, title: "t", context: { chart: true, today: false, noteIds: [] }, turns: [] });
    s.clearBirth();
    expect(s.getChat("c1")!.context.chart).toBe(false);
  });
});

describe("late AI responses never overwrite newer changes", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("an interpretation is merged for its own language only, keeping newer chat and note changes", async () => {
    const s = await freshStore();
    s.saveReading(reading("r1", { noteIds: ["n1"], ai: { en: aiFor("english") } }));
    // While the Chinese interpretation is being written, the person chats and stops sharing notes.
    s.patchReading("r1", (r) => ({ ...r, thread: [{ role: "user", content: "hi", at: "t1" }] }));
    s.patchReading("r1", (r) => ({ ...r, noteIds: [] }));
    // The late response is applied the way the reading page applies it.
    s.patchReading("r1", (r) => (r.ai?.zh ? r : { ...r, ai: { ...r.ai, zh: aiFor("chinese") } }));
    const r = s.getReading("r1")!;
    expect(r.thread).toHaveLength(1);
    expect(r.noteIds).toEqual([]);
    expect(r.ai?.en?.meta.model).toBe("english");
    expect(r.ai?.zh?.meta.model).toBe("chinese");
  });

  it("a reply is appended only if the message it answers is still the newest one", async () => {
    const s = await freshStore();
    const q1 = { role: "user" as const, content: "first", at: "t1" };
    const reply = { role: "assistant" as const, content: "answer", at: "t2" };
    expect(s.appendReply([q1], q1, reply)).toEqual([q1, reply]);
    expect(s.appendReply([], q1, reply)).toBeNull(); // the person withdrew the message
    expect(s.appendReply([q1, { role: "user", content: "second", at: "t3" }], q1, reply)).toBeNull(); // they wrote again
  });
});

describe("visits", () => {
  beforeEach(() => vi.unstubAllGlobals());
  it("returns the previous visit, and a new visit starts after 30 minutes away", async () => {
    const s = await freshStore();
    expect(s.recordVisit(new Date("2026-10-01T10:00:00Z"))).toBeNull();
    expect(s.recordVisit(new Date("2026-10-01T10:20:00Z"))).toBeNull(); // same visit
    expect(s.recordVisit(new Date("2026-10-04T09:00:00Z"))).toBe("2026-10-01T10:20:00.000Z");
  });
});
