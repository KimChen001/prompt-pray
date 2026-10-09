"use client";
// "Share image": renders a PNG on this device from a ShareCard, then offers download or the system
// share sheet. Nothing is uploaded. Optional fields (question, nickname) are off by default.
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { ShareCard } from "@/lib/share/content";
import { renderShareCard } from "@/lib/share/render";

export interface ShareOption {
  key: string;
  label: string;
}

export function ShareImage({ build, options = [], filename }: { build: (opts: Record<string, boolean>) => ShareCard; options?: ShareOption[]; filename: string }) {
  const { m } = useI18n();
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<{ url: string; blob: Blob } | "loading" | "failed" | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let url: string | null = null;
    setState("loading");
    renderShareCard(build(opts))
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setState({ url, blob });
      })
      .catch(() => !cancelled && setState("failed"));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-render when opened or options change
  }, [open, opts]);

  if (!open) return <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>{m.share.button}</button>;

  const ready = state && typeof state === "object" ? state : null;
  const file = ready ? new File([ready.blob], filename, { type: "image/png" }) : null;
  const canShareFile = !!file && typeof navigator !== "undefined" && !!navigator.canShare?.({ files: [file] });

  return (
    <section className="panel stack gap-12" aria-label={m.share.button} style={{ flexBasis: "100%" }}>
      {options.map((o) => (
        <label key={o.key} className="check">
          <input type="checkbox" checked={!!opts[o.key]} onChange={(e) => setOpts({ ...opts, [o.key]: e.target.checked })} />
          {o.label}
        </label>
      ))}
      {state === "loading" && <p className="muted small" style={{ margin: 0 }}>{m.share.preparing}</p>}
      {state === "failed" && <p className="notice" style={{ margin: 0 }}>{m.share.failed}</p>}
      {ready && <img src={ready.url} alt={m.share.previewAlt} style={{ width: "100%", maxWidth: 360, borderRadius: 12, border: "1px solid var(--line)" }} />}
      <div className="btn-row">
        {ready && <a className="btn btn-primary" href={ready.url} download={filename}>{m.share.download}</a>}
        {canShareFile && <button type="button" className="btn btn-ghost" onClick={() => navigator.share({ files: [file!] }).catch(() => undefined)}>{m.share.shareFile}</button>}
        <button type="button" className="btn-text" onClick={() => setOpen(false)}>{m.share.close}</button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>{m.share.privacy}</p>
    </section>
  );
}
