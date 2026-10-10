// The words on the packs panel for each payment mode (spec §10.4). Safe for the browser: it only
// picks strings. Test and simulation always say so, and "not enabled" never comes with a button.
import { fmt } from "@/lib/i18n";
import type { Messages } from "@/lib/i18n/en";
import type { PaymentsState } from "./config";
import type { SalesReason } from "./service";

export type PurchaseAction = null | { kind: "buy" | "test" | "simulate" };

export interface PacksCopy { eyebrow: string; title: string; body: string; cta: string | null; badge: "test" | "sim" | null }

export function packsCopy(m: Messages, state: PaymentsState, sales: { open: boolean; reason: SalesReason | null }, action: PurchaseAction, product: { price: string; readings: number } = { price: "", readings: 5 }): PacksCopy {
  const p = m.packs;
  const title = p.title;
  switch (state) {
    case "fake":
      return { eyebrow: p.eyebrow.sim, title, body: p.body.sim, cta: action?.kind === "simulate" ? p.simulate : null, badge: "sim" };
    case "test":
      return { eyebrow: p.eyebrow.test, title, body: action ? p.body.testOps : p.body.testPublic, cta: action?.kind === "test" ? p.test : null, badge: "test" };
    case "live":
      return { eyebrow: p.eyebrow.live, title, body: sales.open ? p.body.open : p.body.closed, cta: action?.kind === "buy" ? fmt(p.buy, { readings: product.readings, price: product.price }) : null, badge: null };
    default:
      return { eyebrow: p.eyebrow.off, title, body: p.body.off, cta: null, badge: null };
  }
}
