// The shared Whispers wall is not live; these are the agreed post rules and the honest stub.
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { checkWallPost, WALL_MAX } from "@/lib/whispers/policy";
import { GET, POST } from "@/app/api/whispers/route";
import en from "@/lib/i18n/en";
import zh from "@/lib/i18n/zh";

describe("shared wall post rules", () => {
  it("accepts a short anonymous thought", () => {
    expect(checkWallPost("  Tonight I finally said no, and it felt okay.  ")).toEqual({ ok: true, text: "Tonight I finally said no, and it felt okay." });
    expect(checkWallPost("今晚终于说了不，感觉还好。")).toMatchObject({ ok: true });
  });
  it.each([
    ["", "empty"],
    ["x".repeat(WALL_MAX + 1), "too_long"],
    ["see www.example.com", "link"],
    ["read https://x.io/a", "link"],
    ["mail me at a.b@example.org", "contact"],
    ["call 617 555 0199", "contact"],
    ["dm @someone_here", "contact"],
    ["I want to die", "crisis"],
    ["我不想活了", "crisis"],
  ])("rejects %j (%s)", (text, reason) => {
    expect(checkWallPost(text)).toEqual({ ok: false, reason });
  });
});

describe("/api/whispers", () => {
  it("stores nothing and says it is not live", async () => {
    const post = await POST(new NextRequest("http://localhost/api/whispers", { method: "POST", body: JSON.stringify({ text: "hello there" }) }));
    expect(post.status).toBe(501);
    expect(await post.json()).toEqual({ code: "not_live", check: { ok: true } });
    const get = await GET();
    expect(get.status).toBe(501);
    expect(await get.json()).toEqual({ code: "not_live" });
  });
  it("lists every open decision in both languages", () => {
    for (const m of [en, zh]) expect(Object.keys(m.whispers.decisions).sort()).toEqual(["age", "moderation", "replies", "retention", "stats", "visibility"]);
  });
});
