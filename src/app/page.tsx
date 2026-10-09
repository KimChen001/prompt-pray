"use client";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { CheckInsDue } from "@/components/CheckIns";

const TILES = [
  { key: "tarot", href: "/tarot", ready: true },
  { key: "today", href: "/today", ready: true },
  { key: "chart", href: "/chart", ready: true },
  { key: "match", href: "/match", ready: true },
  { key: "learn", href: "/learn", ready: true },
  { key: "whispers", href: "/whispers", ready: false, date: { en: "Oct 17", zh: "10月17日" } },
] as const;

export default function HomePage() {
  const { m, fmt, locale } = useI18n();
  return (
    <div className="stack gap-48">
      <section className="hero">
        <div className="hero-logo"><img src="/brand/moona-logo.webp" alt="MOONA zodiac wheel logo" /></div>
        <div className="stack gap-16">
          <p className="meta" style={{ margin: 0 }}>{m.home.eyebrow}</p>
          <h1 className="display">{m.home.title}</h1>
          <p className="lede">{m.home.subtitle}</p>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <Link href="/tarot/new" className="btn btn-primary">{m.home.start}</Link>
            <Link href="/today" className="btn btn-ghost">{m.home.today}</Link>
          </div>
        </div>
      </section>

      <CheckInsDue />

      <section className="stack gap-16">
        <h2 className="h2">{m.home.modules}</h2>
        <div className="grid-tiles">
          {TILES.map((t) => (
            <Link key={t.key} href={t.href} className="tile">
              <span className={t.ready ? "badge badge-ready" : "badge badge-dev"} style={{ alignSelf: "flex-start" }}>
                {t.ready ? m.home.ready : fmt(m.home.devOn, { date: t.date[locale] })}
              </span>
              <span className="h3">{m.home.tiles[t.key].title}</span>
              <p>{m.home.tiles[t.key].desc}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
