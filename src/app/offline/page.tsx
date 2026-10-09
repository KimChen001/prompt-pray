"use client";
// Shown by the service worker when a page isn't available offline. The static orb needs no network.
import Link from "next/link";
import { useI18n } from "@/lib/i18n";

export default function OfflinePage() {
  const { m } = useI18n();
  return (
    <div className="form-page" style={{ textAlign: "center" }}>
      <div className="nebula" style={{ ["--orb" as string]: "160px" }} aria-hidden="true"><span className="nebula-static" /></div>
      <header className="page-head page-head-center">
        <p className="eyebrow">{m.offline.eyebrow}</p>
        <h1 className="h1">{m.offline.title}</h1>
        <p className="lede">{m.offline.body}</p>
        <p className="muted small" style={{ margin: 0 }}>{m.offline.needsNet}</p>
      </header>
      <div className="btn-row" style={{ justifyContent: "center" }}>
        <Link href="/tarot/new" className="btn btn-primary btn-lg">{m.home.start}</Link>
        <Link href="/today" className="btn btn-ghost">{m.nav.today}</Link>
        <Link href="/me" className="btn btn-text">{m.nav.journal}</Link>
      </div>
    </div>
  );
}
