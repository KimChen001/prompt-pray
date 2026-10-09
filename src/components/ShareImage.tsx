"use client";
// Sharing (overall review §7): one sheet for both the image and the text, with the same options and
// the same defaults — the question (and the other person's nickname) are left out unless ticked. The
// preview shows exactly what will be shared: the PNG is made on this device and never uploaded, and
// the text preview is the exact text that is copied or handed to the system share sheet. AI text
// can still mention personal things, which is why the preview is shown before anything leaves.
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { ShareCard } from "@/lib/share/content";
import { renderShareCard } from "@/lib/share/render";

export interface ShareOption {
  key: string;
  label: string;
}

type Opts = Record<string, boolean>;

export function ShareSheet({
  build, text, options = [], filename, label,
}: {
  build: (opts: Opts) => ShareCard;
  /** Plain-text version; omit for image-only sharing. */
  text?: (opts: Opts) => string;
  options?: ShareOption[];
  filename: string;
  label?: string;
}) {
  const { m } = useI18n();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"image" | "text">("image");
  const [opts, setOpts] = useState<Opts>({});
  const [state, setState] = useState<{ url: string; blob: Blob } | "loading" | "failed" | null>(null);
  const [copied, setCopied] = useState(false);
  const shareText = useMemo(() => (text && open ? text(opts) : ""), [text, opts, open]);

  useEffect(() => {
    if (!open || mode !== "image") return;
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
  }, [open, opts, mode]);

  if (!open) return <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>{label ?? (text ? m.share.open : m.share.button)}</button>;

  const ready = state && typeof state === "object" ? state : null;
  const file = ready ? new File([ready.blob], filename, { type: "image/png" }) : null;
  const canShareFile = !!file && typeof navigator !== "undefined" && !!navigator.canShare?.({ files: [file] });
  const canShareText = typeof navigator !== "undefined" && typeof navigator.share === "function";

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="panel share-sheet" aria-label={m.share.title}>
      <div className="row-between">
        <h2 className="h3">{m.share.title}</h2>
        {text && (
          <div className="seg" role="group" aria-label={m.share.format}>
            <button type="button" aria-pressed={mode === "image"} onClick={() => setMode("image")}>{m.share.image}</button>
            <button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")}>{m.share.text}</button>
          </div>
        )}
      </div>
      {options.map((o) => (
        <label key={o.key} className="check">
          <input type="checkbox" checked={!!opts[o.key]} onChange={(e) => setOpts({ ...opts, [o.key]: e.target.checked })} />
          {o.label}
        </label>
      ))}

      {mode === "image" ? (
        <>
          {state === "loading" && <p className="muted small" style={{ margin: 0 }}>{m.share.preparing}</p>}
          {state === "failed" && <p className="notice">{m.share.failed}</p>}
          {ready && <img src={ready.url} alt={m.share.previewAlt} style={{ width: "100%", maxWidth: 360, borderRadius: 12, border: "1px solid var(--line)" }} />}
          <div className="btn-row">
            {ready && <a className="btn btn-primary" href={ready.url} download={filename}>{m.share.download}</a>}
            {canShareFile && <button type="button" className="btn btn-ghost" onClick={() => navigator.share({ files: [file!] }).catch(() => undefined)}>{m.share.shareFile}</button>}
            <button type="button" className="btn-text" onClick={() => setOpen(false)}>{m.share.close}</button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>{m.share.privacy}</p>
        </>
      ) : (
        <>
          <pre className="share-preview-text" aria-label={m.share.textPreview}>{shareText}</pre>
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={copy} aria-live="polite">{copied ? m.common.copied : m.common.copy}</button>
            {canShareText && <button type="button" className="btn btn-ghost" onClick={() => navigator.share({ text: shareText }).catch(() => undefined)}>{m.share.shareFile}</button>}
            <button type="button" className="btn-text" onClick={() => setOpen(false)}>{m.share.close}</button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>{m.share.textPrivacy}</p>
        </>
      )}
    </section>
  );
}

/** Image-only sharing (today's card, Big Three, match). */
export function ShareImage(props: { build: (opts: Opts) => ShareCard; options?: ShareOption[]; filename: string }) {
  return <ShareSheet {...props} />;
}
