"use client";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";

export default function NotFound() {
  const { m } = useI18n();
  return (
    <div className="stack gap-16" style={{ maxWidth: 560 }}>
      <h1 className="h1">404</h1>
      <div><Link href="/" className="btn btn-primary">{m.nav.home}</Link></div>
    </div>
  );
}
