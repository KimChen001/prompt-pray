// @vitest-environment happy-dom
// The daily horoscope panel through its real component path (Codex review 2026-10-09 20:51): a
// rewrite the person asked for pays once, coming back to a sign never pays again on its own, a failed
// rewrite needs a new click, and switching away and back while a request runs joins it.
import { createElement, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { HoroscopePanel } from "@/components/HoroscopePanel";
import { cacheHoroscope, updateSettings } from "@/lib/store";
import { dayHoroscope, horoscopeCacheKey } from "@/lib/astro/horoscope-day";
import { HOROSCOPE_VERSIONS } from "@/lib/ai/horoscope-prompt";
import type { Sign } from "@/lib/astro/zodiac";

vi.mock("next/link", () => ({ default: (p: { href: string; children: ReactNode }) => createElement("a", { href: p.href }, p.children) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATE = "2026-10-12", TZ = "America/New_York";
const OLD = "horoscope-rules@2|horoscope@2";
const STALE_SERVER = "horoscope-rules@2|horoscope@3|claims@2"; // a server on other versions (deploy skew)
const meta = { generatedAt: "2026-10-12T12:00:00Z", model: "mock", provider: "fake" as const, source: "simulated" as const };

interface Call { sun: string[]; resolve: (r: Response) => void }
let calls: Call[] = [];
let root: Root | null = null;
let container: HTMLElement;

const keyFor = (sign: Sign) => horoscopeCacheKey(dayHoroscope({ sunSign: sign }, DATE, TZ), DATE, TZ, "en");
const reply = (sign: string, versions: string) => new Response(JSON.stringify({ overall: `Mock updated text for ${sign}`, love: "Say plainly what you feel.", work: "Finish one thing fully.", meta, versions }), { status: 200, headers: { "Content-Type": "application/json" } });
const text = () => container.textContent ?? "";
const button = (label: string) => {
  const b = [...container.querySelectorAll("button")].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button "${label}" in: ${text().slice(0, 400)}`);
  return b;
};
const click = (label: string) => act(async () => { button(label).click(); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function answer(i: number, r: Response) {
  await act(async () => { calls[i].resolve(r); await new Promise((x) => setTimeout(x, 0)); });
}
async function pickSign(name: string) {
  await click("Change sign");
  await click(name);
}

async function render(strict = false) {
  const panel = createElement(I18nProvider, { initialLocale: "en", children: createElement(HoroscopePanel, { localDate: DATE, timeZone: TZ }) });
  root = createRoot(container);
  await act(async () => { root!.render(strict ? createElement(StrictMode, null, panel) : panel); });
  await settle();
}

beforeEach(() => {
  localStorage.clear();
  calls = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve) => {
    calls.push({ sun: JSON.parse(String(init.body)).subject.sun, resolve });
  })));
  updateSettings({ sunSign: "leo" });
  cacheHoroscope(keyFor("leo"), { overall: "A steady day to reflect.", love: "Say plainly what you feel.", work: "Finish one thing fully.", meta, versions: OLD });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

describe("horoscope panel rewrites", () => {
  it("pays once for an asked rewrite, once for a new sign, and never again on the way back", async () => {
    await render();
    expect(calls).toHaveLength(0); // an older saved text is shown, not rewritten silently
    expect(text()).toContain("Write it again with the current rules");
    await click("Write it again with the current rules");
    expect(calls).toHaveLength(1);
    await answer(0, reply("leo", STALE_SERVER));
    expect(text()).toContain("Mock updated text for leo");
    await pickSign("Aries");
    expect(calls).toHaveLength(2);
    expect(calls[1].sun).toEqual(["aries"]);
    await answer(1, reply("aries", HOROSCOPE_VERSIONS));
    expect(text()).toContain("Mock updated text for aries");
    await pickSign("Leo");
    await settle();
    expect(calls).toHaveLength(2);
    expect(text()).toContain("Mock updated text for leo");
    // and Aries, saved under the current versions, is read back as is
    await pickSign("Aries");
    await settle();
    expect(calls).toHaveLength(2);
  });

  it("needs a new click after a failed rewrite, even after switching away and back", async () => {
    await render();
    await click("Write it again with the current rules");
    await answer(0, new Response("{}", { status: 500 }));
    expect(text()).toContain("AI is unavailable right now");
    expect(text()).toContain("A steady day to reflect."); // the older text still holds and stays
    await pickSign("Aries");
    await answer(1, reply("aries", HOROSCOPE_VERSIONS));
    await pickSign("Leo");
    await settle();
    expect(calls).toHaveLength(2);
    expect(text()).toContain("Write it again with the current rules");
    await click("Write it again with the current rules");
    expect(calls).toHaveLength(3);
    await answer(2, new Response("{}", { status: 500 }));
    // the failure notice's retry is a new rewrite the person asks for
    await click("Try AI again");
    expect(calls).toHaveLength(4);
    await answer(3, reply("leo", HOROSCOPE_VERSIONS));
    expect(text()).toContain("Mock updated text for leo");
  });

  it("joins a running request when the person switches away and back", async () => {
    await render();
    await click("Write it again with the current rules");
    await pickSign("Aries");
    await pickSign("Leo");
    await settle();
    expect(calls.map((c) => c.sun)).toEqual([["leo"], ["aries"]]);
    await answer(0, reply("leo", HOROSCOPE_VERSIONS));
    expect(text()).toContain("Mock updated text for leo");
    await answer(1, reply("aries", HOROSCOPE_VERSIONS)); // saved for Aries while Leo is shown
    expect(text()).toContain("Mock updated text for leo");
    await pickSign("Aries");
    await settle();
    expect(calls).toHaveLength(2);
    expect(text()).toContain("Mock updated text for aries");
  });

  it("sends one request for a new sign under React strict mode", async () => {
    updateSettings({ sunSign: "virgo" });
    await render(true);
    expect(calls).toHaveLength(1);
    await answer(0, reply("virgo", HOROSCOPE_VERSIONS));
    expect(text()).toContain("Mock updated text for virgo");
  });
});
