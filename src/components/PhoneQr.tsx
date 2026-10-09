"use client";
// "Try it on your phone" (design supplement §8): a QR code for the public home page and the same
// address as readable text. The address comes from NEXT_PUBLIC_SITE_URL (the deployed HTTPS site);
// without it, this page's own address is used and clearly labelled as a test address. The code
// never carries a question, birth details, reading ids, keys or access codes — only the site root.
import { useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { useI18n } from "@/lib/i18n";
import { Icon } from "./icons";

const CONFIGURED = process.env.NEXT_PUBLIC_SITE_URL ?? "";

export type QrTarget = { url: string; status: "public" | "test" | "local" };

/** The address to encode: always the site root, nothing else. */
export function qrTarget(configured: string, origin: string): QrTarget {
  const pick = configured || origin;
  let u: URL;
  try {
    u = new URL(pick);
  } catch {
    u = new URL(origin);
  }
  const root = `${u.protocol}//${u.host}/`;
  const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(u.hostname);
  if (local) return { url: root, status: "local" };
  return { url: root, status: configured && u.protocol === "https:" ? "public" : "test" };
}

export function QrSvg({ text, label }: { text: string; label: string }) {
  const path = useMemo(() => {
    const { data, size } = encode(text, { ecc: "M", border: 2 });
    let d = "";
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[y][x]) d += `M${x} ${y}h1v1h-1z`;
    return { d, size };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${path.size} ${path.size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={path.size} height={path.size} fill="#f0ede7" />
      <path d={path.d} fill="#0e0d16" />
    </svg>
  );
}

export function PhoneQr({ open = false }: { open?: boolean }) {
  const { m } = useI18n();
  const [target, setTarget] = useState<QrTarget | null>(null);
  useEffect(() => setTarget(qrTarget(CONFIGURED, window.location.origin)), []);

  if (open) {
    // Inside a dialog (the rail's "Try it on your phone"): the code and address directly.
    return (
      <div className="stack gap-3">
        <h2 className="font-serif-i text-[30px] leading-[1.1]">{m.qr.title}</h2>
        <p className="muted small" style={{ margin: 0 }}>{m.qr.teaser}</p>
        {target && (
          <>
            <div className="qr-code" style={{ width: 200, height: 200, alignSelf: "center" }}><QrSvg text={target.url} label={m.qr.alt} /></div>
            {target.status !== "public" && <span className="badge badge-dev" style={{ alignSelf: "flex-start" }}>{target.status === "local" ? m.qr.localBadge : m.qr.testBadge}</span>}
            <p className="qr-url" style={{ margin: 0 }}>{target.url.replace(/\/$/, "")}</p>
            <p className="muted small" style={{ margin: 0 }}>{target.status === "local" ? m.qr.localNote : target.status === "test" ? m.qr.testNote : m.qr.publicNote}</p>
            <p className="muted small" style={{ margin: 0 }}>{m.qr.privacy}</p>
          </>
        )}
      </div>
    );
  }

  return (
    <details className="disclosure panel-quiet">
      <summary>
        <span className="disclosure-summary">
          <Icon name="phone" size={20} />
          <span style={{ color: "var(--text-1)" }}>{m.qr.title}</span>
          <span className="muted small">{m.qr.teaser}</span>
        </span>
      </summary>
      {target && (
        <div className="qr-panel" style={{ marginTop: 14 }}>
          <div className="qr-code"><QrSvg text={target.url} label={m.qr.alt} /></div>
          <div className="stack gap-2" style={{ maxWidth: 420 }}>
            {target.status !== "public" && <span className="badge badge-dev" style={{ alignSelf: "flex-start" }}>{target.status === "local" ? m.qr.localBadge : m.qr.testBadge}</span>}
            <p className="qr-url" style={{ margin: 0 }}>{target.url.replace(/\/$/, "")}</p>
            <p className="muted small" style={{ margin: 0 }}>{target.status === "local" ? m.qr.localNote : target.status === "test" ? m.qr.testNote : m.qr.publicNote}</p>
            <p className="muted small" style={{ margin: 0 }}>{m.qr.privacy}</p>
          </div>
        </div>
      )}
    </details>
  );
}
