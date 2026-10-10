// @vitest-environment happy-dom
// The chat composer's Send button keeps focus in the text box when pressed (verification workflow,
// 2026-10-10): on phones the dock moves when the box loses focus, so a tap's release missed the button.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { Composer } from "@/components/chat/ChatParts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("chat composer", () => {
  it("does not take focus from the text box when Send is pressed, and still sends on click", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onSend = vi.fn();
    const root = createRoot(container);
    await act(async () => { root.render(createElement(I18nProvider, { initialLocale: "en", children: createElement(Composer, { value: "hello", onChange: () => undefined, onSend, placeholder: "Ask", label: "Ask" }) })); });
    const send = [...container.querySelectorAll("button")].find((b) => b.textContent === "Send")!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    send.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await act(async () => { send.click(); });
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    container.remove();
  });
});
