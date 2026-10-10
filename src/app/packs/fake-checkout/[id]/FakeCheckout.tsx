"use client";
// The simulated provider's buttons: each sends signed, provider-shaped events through the real
// webhook path (/api/ops/fake-pay). No payment service is involved and no money moves.
import Link from "next/link";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";

type Outcome = "pay" | "decline" | "expire";

export function FakeCheckout({ orderId }: { orderId: string }) {
  const { m, fmt, locale } = useI18n();
  const c = m.packs.fakeCheckout;
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(outcome: Outcome, duplicate = false) {
    setBusy(true);
    try {
      const res = await fetch("/api/ops/fake-pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId, outcome, duplicate }) });
      const body = (await res.json().catch(() => ({}))) as { outcomes?: string[]; code?: string };
      setSent(fmt(c.sent, { outcomes: (body.outcomes ?? [body.code ?? String(res.status)]).map((o) => c.outcomes[o] ?? o).join(locale === "zh" ? "，" : ", ") }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack gap-6" style={{ maxWidth: 560 }}>
      <section className="panel stack gap-3">
        <span className="badge badge-dev" style={{ alignSelf: "flex-start" }}>{m.packs.eyebrow.sim}</span>
        <h1 className="h3">{c.title}</h1>
        <p className="muted" style={{ margin: 0 }}>{c.body}</p>
        <div className="btn-row">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void send("pay")}>{c.pay}</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void send("decline")}>{c.decline}</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void send("expire")}>{c.expire}</button>
          <button type="button" className="btn-text" disabled={busy} onClick={() => void send("pay", true)}>{c.twice}</button>
        </div>
        {sent && <p className="notice-quiet" aria-live="polite" style={{ margin: 0 }}>{sent}</p>}
        <Link href={`/me?order=${orderId}#packs`} className="btn-text">{c.back}</Link>
      </section>
    </div>
  );
}
