"use client";
// Reading packs on Me (spec §10.2). Nothing is shown while payments are off, so the page looks exactly
// as approved; in fake or test mode the panel says so in its first line, and a purchase button appears
// only when the server says this device may use it. Credits are always read from the server: coming
// back from checkout never adds anything by itself, the page asks until the provider has confirmed.
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { newRequestId } from "@/lib/ai/client";
import { packsCopy, type PurchaseAction } from "@/lib/payments/copy";
import type { EntitlementView, OrderView } from "@/lib/ledger/port";
import type { PaymentsState } from "@/lib/payments/config";
import type { SalesReason } from "@/lib/payments/service";

interface PacksInfo {
  payments: { state: PaymentsState; problems?: string[] };
  sales: { open: boolean; reason: SalesReason | null };
  action: PurchaseAction;
  product: { priceCents: number; currency: string; readings: number; followupsPerReading: number; model: string; termsUrl: string | null; refundUrl: string | null; support: string | null };
  account: { signedIn: boolean; provider: string };
  entitlements?: EntitlementView;
}

const KEY = "moona.checkoutKey";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const store = {
  get: () => { try { return sessionStorage.getItem(KEY); } catch { return null; } },
  set: (v: string) => { try { sessionStorage.setItem(KEY, v); } catch { /* private mode: a new key next time */ } },
  clear: () => { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } },
};

export function CreditMeter({ left, total, label }: { left: number; total: number; label: string }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : 0;
  return (
    <div className="stack gap-1">
      <span className="meta">{label}</span>
      <div className="credit-meter" role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={left} aria-label={label}><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function PacksPanel({ onVisible }: { onVisible?: (visible: boolean) => void }) {
  const { m, fmt, locale } = useI18n();
  const [info, setInfo] = useState<PacksInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const polling = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/packs", { cache: "no-store" });
      const body = (await res.json()) as PacksInfo;
      setInfo(body);
      onVisible?.(body.payments.state !== "unconfigured");
      return body;
    } catch {
      onVisible?.(false);
      return null;
    }
  }, [onVisible]);

  useEffect(() => { void load(); }, [load]);

  // Back from checkout (?order=<id>): ask the server until the provider has confirmed, for up to 2 minutes.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("order");
    if (!id || !UUID.test(id) || polling.current) return;
    polling.current = true;
    let stop = false;
    const started = Date.now();
    void (async () => {
      while (!stop && Date.now() - started < 120_000) {
        try {
          const res = await fetch(`/api/packs/orders/${id}`, { cache: "no-store" });
          if (res.ok) {
            const { order } = (await res.json()) as { order: OrderView };
            if (order.state === "paid") { setMessage(fmt(m.packs.poll.paid, { n: order.readings })); store.clear(); void load(); return; }
            if (order.state === "expired" || order.state === "canceled") { setMessage(m.packs.poll.closed); store.clear(); void load(); return; }
            if (order.state === "needs_review" || order.state === "paid_unfunded") { setMessage(fmt(m.packs.poll.review, { support: info?.product.support ?? "MOONA" })); store.clear(); return; }
            setMessage(m.packs.poll.pending);
          }
        } catch {
          setMessage(m.packs.poll.pending);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page load
  }, []);

  if (!info || info.payments.state === "unconfigured") return null;

  const price = new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", { style: "currency", currency: info.product.currency.toUpperCase() }).format(info.product.priceCents / 100);
  const copy = packsCopy(m, info.payments.state, info.sales, info.action, { price, readings: info.product.readings });
  const e = info.entitlements;
  const paidOrders = e?.orders.filter((o) => o.state === "paid").length ?? 0;
  const total = Math.max(e?.credits ?? 0, paidOrders * info.product.readings);

  async function buy() {
    setBusy(true);
    setMessage(m.packs.starting);
    const checkoutKey = store.get() ?? newRequestId();
    store.set(checkoutKey);
    try {
      const res = await fetch("/api/packs/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: "tarot5", checkoutKey }) });
      const body = (await res.json().catch(() => ({}))) as { url?: string; code?: string; reason?: SalesReason };
      if (res.ok && body.url) {
        window.location.assign(body.url);
        return;
      }
      if (body.code === "login_required") setMessage(m.packs.needsAccount);
      else if (body.code === "order_closed") { store.clear(); setMessage(m.packs.poll.closed); }
      else setMessage((body.reason && m.packs.reasons[body.reason]) || m.packs.reasons.ledger);
      void load();
    } catch {
      setMessage(m.packs.reasons.ledger);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="packs" className="panel stack gap-3 journal-section" aria-labelledby="packs-title">
      <div className="row" style={{ gap: 10 }}>
        <p className="eyebrow">{copy.eyebrow}</p>
        {copy.badge && <span className="badge badge-dev">{copy.badge === "test" ? m.packs.eyebrow.test : m.packs.eyebrow.sim}</span>}
      </div>
      <h2 className="h3" id="packs-title">{copy.title}</h2>
      <p style={{ margin: 0 }}>{copy.body}</p>
      {info.payments.problems && <ul className="muted small" style={{ margin: 0, paddingLeft: 18 }}>{info.payments.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {info.action && (
        <p className="muted small" style={{ margin: 0 }}>
          {fmt(m.packs.terms, { price, readings: info.product.readings, followups: info.product.followupsPerReading, model: info.product.model })}
          {info.product.termsUrl && <> <a href={info.product.termsUrl} target="_blank" rel="noreferrer">{m.packs.termsLink}</a></>}
          {info.product.refundUrl && <> · <a href={info.product.refundUrl} target="_blank" rel="noreferrer">{m.packs.refundLink}</a></>}
          {info.product.support && <> · {fmt(m.packs.support, { contact: info.product.support })}</>}
        </p>
      )}
      {info.account.provider === "none" && <p className="muted small" style={{ margin: 0 }}>{m.packs.needsAccount}</p>}
      {info.account.provider === "fake" && info.account.signedIn && <p className="muted small" style={{ margin: 0 }}>{m.packs.fakeAccount}</p>}
      {!info.sales.open && info.sales.reason && info.payments.state !== "misconfigured" && <p className="muted small" style={{ margin: 0 }}>{m.packs.reasons[info.sales.reason]}</p>}

      {e && total > 0 && <CreditMeter left={e.credits} total={total} label={fmt(m.packs.credits, { n: e.credits, total })} />}
      {e && e.readings.length > 0 && (
        <div className="stack gap-1">
          <span className="meta">{m.packs.readingsTitle}</span>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{e.readings.map((r, i) => <li key={r.paidReadingId}>{i + 1}. {fmt(m.packs.followupsLeft, { n: r.followupsLeft })}</li>)}</ul>
        </div>
      )}
      {e && e.orders.length > 0 && (
        <div className="stack gap-1">
          <span className="meta">{m.packs.ordersTitle}</span>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {e.orders.map((o) => <li key={o.id}>{new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(o.createdAt))} · {m.packs.orderState[o.state]}{o.mode !== "live" ? ` · ${o.mode === "fake" ? m.packs.eyebrow.sim : m.packs.eyebrow.test}` : ""}</li>)}
          </ul>
        </div>
      )}
      {message && <p className="notice-quiet" aria-live="polite" style={{ margin: 0 }}>{message}</p>}
      {copy.cta && (
        <div className="btn-row">
          <button type="button" className={info.action?.kind === "buy" ? "btn btn-primary" : "btn btn-ghost"} onClick={() => void buy()} disabled={busy}>{copy.cta}</button>
        </div>
      )}
    </section>
  );
}
