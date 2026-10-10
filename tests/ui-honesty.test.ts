// What the pages say about money and AI (spec §11 ui-honesty): test and simulation always say so, "not
// enabled" never comes with a button, a real purchase is offered only live and open, and a simulated
// reading is never labelled live AI.
import { describe, expect, it } from "vitest";
import en from "@/lib/i18n/en";
import zh from "@/lib/i18n/zh";
import { packsCopy } from "@/lib/payments/copy";
import { purchaseAction, type SalesReason } from "@/lib/payments/service";
import type { PaymentsState } from "@/lib/payments/config";

const open: { open: boolean; reason: SalesReason | null } = { open: true, reason: null };
const product = { price: "$5.00", readings: 5 };
const local = { isOperator: false, deployed: false };
const copy = (m: typeof en, state: PaymentsState, sales = open, ctx = local) => packsCopy(m, state, sales, purchaseAction(state, sales.open, ctx), product);

describe("honest packs copy", () => {
  it("marks test mode as test, with no real charge", () => {
    const e = copy(en, "test"), z = copy(zh, "test");
    expect(`${e.eyebrow} ${e.body}`).toContain("TEST MODE");
    expect(e.body).toContain("No real charge");
    expect(e.cta).toBe("Test purchase (no real charge)");
    expect(`${z.eyebrow} ${z.body}`).toContain("测试模式");
    expect(z.body).toContain("不会产生真实扣款");
    expect(e.badge).toBe("test");
    // the public on a deployment sees no test button and no promise of a sale
    const pub = copy(en, "test", open, { isOperator: false, deployed: true });
    expect(pub.cta).toBeNull();
    expect(pub.body).toBe("Packs are being tested and are not on sale yet.");
  });

  it("says payments are not enabled, with no button, when unconfigured or misconfigured", () => {
    for (const state of ["unconfigured", "misconfigured"] as const) {
      const e = copy(en, state), z = copy(zh, state);
      expect(e.body).toContain("not enabled");
      expect(z.body).toContain("尚未开通");
      expect(e.cta).toBeNull();
      expect(z.cta).toBeNull();
    }
  });

  it("says no money moves in simulation", () => {
    expect(copy(en, "fake").body).toContain("no money moves");
    expect(copy(zh, "fake").body).toContain("不会产生任何扣款");
    expect(copy(en, "fake").cta).toBe("Simulated purchase");
    expect(copy(en, "fake").badge).toBe("sim");
  });

  it("offers a real purchase only live and open", () => {
    expect(copy(en, "live").cta).toBe("Buy 5 readings — $5.00");
    expect(copy(en, "live", { open: false, reason: "sold_out" }).cta).toBeNull();
    expect(copy(en, "live", { open: false, reason: "sold_out" }).body).toContain("sold out");
    for (const state of ["fake", "test", "unconfigured", "misconfigured"] as const) expect(copy(en, state).cta ?? "").not.toMatch(/^Buy/);
  });

  it("never labels a simulated reading as live AI", () => {
    for (const m of [en, zh]) {
      expect(m.badge.simulated).not.toBe(m.badge.live);
      expect(m.badge.simulated).not.toMatch(/live ai|ai 实时/i);
    }
    expect(en.badge.simulated).toBe("Simulated reading — no AI call");
    expect(zh.badge.simulated).toBe("模拟解读——未调用 AI");
  });
});
