import { describe, expect, it } from "vitest";
import requests from "../eval/requests.json";
import { buildCases } from "../eval/build";
import { parseNatalRequest } from "@/lib/ai/natal-prompt";
import { parseTarotRequest, tarotNeedsSupport } from "@/lib/ai/tarot-prompt";
import { chatNeedsSupport, parseChatRequest } from "@/lib/ai/chat-prompt";
import { parseHoroscopeRequest } from "@/lib/ai/horoscope-prompt";

type C = (typeof requests.cases)[number] & { expectCode?: string };
const cases = requests.cases as C[];

describe("evaluation set", () => {
  it("is up to date with eval/build.ts (run `npx tsx eval/build.ts` after changing it)", () => {
    expect(JSON.parse(JSON.stringify(buildCases()))).toEqual(requests.cases);
  });

  it("has 20–30 cases covering every route and both languages", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.length).toBeLessThanOrEqual(30);
    for (const kind of ["natal", "tarot", "chat", "horoscope", "crisis"]) expect(cases.some((c) => c.kind === kind), kind).toBe(true);
    for (const kind of ["natal", "tarot", "chat", "horoscope"]) {
      expect(cases.some((c) => c.kind === kind && c.locale === "en"), `${kind} en`).toBe(true);
      expect(cases.some((c) => c.kind === kind && c.locale === "zh"), `${kind} zh`).toBe(true);
    }
  });

  it("sends bodies the server accepts, and crisis cases never reach a model", () => {
    for (const c of cases) {
      const body = c.body as never;
      if (c.endpoint === "/api/ai/natal") expect(parseNatalRequest(body), c.id).not.toBeNull();
      if (c.endpoint === "/api/ai/horoscope") expect(parseHoroscopeRequest(body), c.id).not.toBeNull();
      if (c.endpoint === "/api/ai/tarot") {
        const r = parseTarotRequest(body)!;
        expect(r, c.id).not.toBeNull();
        expect(tarotNeedsSupport(r), c.id).toBe(c.expectCode === "crisis");
      }
      if (c.endpoint === "/api/ai/chat") {
        const r = parseChatRequest(body)!;
        expect(r, c.id).not.toBeNull();
        expect(chatNeedsSupport(r), c.id).toBe(c.expectCode === "crisis");
      }
    }
  });

  it("covers the hard natal inputs it claims to", () => {
    const facts = (id: string) => (cases.find((c) => c.id === id)!.body as { facts: { kind: string }[]; timeKnown: boolean });
    expect(facts("N4").timeKnown).toBe(false);
    expect(facts("N4").facts.some((f) => f.kind === "uncertainPlacement")).toBe(true);
    expect(facts("N1").facts.some((f) => f.kind === "angle")).toBe(true);
    expect(JSON.stringify(facts("N3").facts)).not.toBe(JSON.stringify(facts("N1").facts)); // Whole Sign changes houses
    expect(cases.find((c) => c.id === "N7")!.context).toContain("Placidus fallback");
    // no birth data in any request
    for (const c of cases.filter((x) => x.kind === "natal")) expect(JSON.stringify(c.body)).not.toMatch(/\d{4}-\d{2}-\d{2}|lat|lon|Cambridge|Sydney/);
  });
});
