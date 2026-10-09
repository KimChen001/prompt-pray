"use client";
// Home (design supplement §4). Phones: brand (header) → breathing nebula → one clear line → "Draw a
// card", then "Explore your chart" and "Talk with MOONA". Desktop: copy and actions on the left, a
// larger nebula on the right, and a "Try it on your phone" QR for the demo. Below: a greeting built
// only from saved records, due check-ins, and every MOONA module (none hidden on phones).
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { CheckInsDue } from "@/components/CheckIns";
import { Nebula } from "@/components/nebula/Nebula";
import { WelcomeBack } from "@/components/WelcomeBack";
import { PhoneQr } from "@/components/PhoneQr";
import { Icon, type IconName } from "@/components/icons";

type TileKey = "today" | "talk" | "chart" | "learn" | "match" | "whispers" | "journal";
const TILES: { key: TileKey; href: string; icon: IconName; status?: "partial" }[] = [
  { key: "today", href: "/today", icon: "today" },
  { key: "talk", href: "/talk", icon: "talk" },
  { key: "chart", href: "/chart", icon: "chart" },
  { key: "learn", href: "/learn", icon: "learn" },
  { key: "match", href: "/match", icon: "match", status: "partial" },
  { key: "whispers", href: "/whispers", icon: "whispers", status: "partial" },
  { key: "journal", href: "/me", icon: "journal" },
];

export default function HomePage() {
  const { m } = useI18n();
  return (
    <div className="home">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero-copy">
          <p className="eyebrow">{m.home.eyebrow}</p>
          <h1 className="display" id="home-title">{m.home.title}</h1>
          <p className="lede">{m.home.subtitle}</p>
          <div className="home-actions">
            <Link href="/tarot/new" className="btn btn-primary btn-lg btn-block">{m.home.start}</Link>
            <div className="btn-row">
              <Link href="/chart" className="btn btn-ghost">{m.home.chart}</Link>
              <Link href="/talk" className="btn btn-ghost">{m.home.talk}</Link>
            </div>
          </div>
          <p className="home-note">{m.home.note}</p>
        </div>
        <Nebula className="home-orb" mode="idle" size="clamp(190px, 62vw, 280px)" interactive particles />
      </section>

      <div className="stack gap-16">
        <WelcomeBack />
        <CheckInsDue />
      </div>

      <section className="stack gap-16" aria-labelledby="modules-title">
        <div className="section-head">
          <h2 className="h2" id="modules-title">{m.home.modules}</h2>
          <span className="muted small">{m.home.modulesNote}</span>
        </div>
        <div className="grid-tiles tiles-compact">
          {TILES.map((t) => (
            <Link key={t.key} href={t.href} className="tile">
              <span className="row-between">
                <Icon name={t.icon} size={30} className="tile-icon" />
                {t.status === "partial" && <span className="badge badge-dev">{m.home.partial}</span>}
              </span>
              <span className="h3">{m.home.tiles[t.key].title}</span>
              <p>{m.home.tiles[t.key].desc}</p>
              <span className="tile-go">{m.home.open} →</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="desktop-only">
        <PhoneQr />
      </section>
    </div>
  );
}
