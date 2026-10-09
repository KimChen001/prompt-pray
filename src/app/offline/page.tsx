"use client";
// Shown by the service worker when a page isn't available offline.
import Link from "next/link";
import { useI18n } from "@/lib/i18n";

export default function OfflinePage() {
  const { m } = useI18n();
  return (
    <div className="stack gap-16" style={{ maxWidth: 560 }}>
      <h1 className="h1">{m.offline.title}</h1>
      <p className="lede">{m.offline.body}</p>
      <p className="muted small" style={{ margin: 0 }}>{m.offline.needsNet}</p>
      <div className="btn-row">
        <Link href="/tarot/new" className="btn btn-primary">{m.home.start}</Link>
        <Link href="/today" className="btn btn-ghost">{m.nav.today}</Link>
      </div>
    </div>
  );
}
