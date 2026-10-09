"use client";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";

export default function NotFound() {
  const { m } = useI18n();
  return (
    <div className="form-page" style={{ textAlign: "center" }}>
      <header className="page-head page-head-center">
        <p className="eyebrow">404</p>
        <h1 className="h1">{m.notFound.title}</h1>
        <p className="lede">{m.notFound.body}</p>
      </header>
      <div className="btn-row" style={{ justifyContent: "center" }}>
        <Link href="/" className="btn btn-primary">{m.nav.home}</Link>
        <Link href="/tarot/new" className="btn btn-ghost">{m.home.start}</Link>
      </div>
    </div>
  );
}
