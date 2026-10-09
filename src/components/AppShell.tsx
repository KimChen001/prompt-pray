"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { IconChart, IconHome, IconInfo, IconLearn, IconMatch, IconMe, IconTarot, IconToday, IconWhispers } from "./icons";

const PRIMARY = [
  { href: "/today", key: "today", Icon: IconToday },
  { href: "/tarot", key: "tarot", Icon: IconTarot },
  { href: "/chart", key: "chart", Icon: IconChart },
  { href: "/whispers", key: "whispers", Icon: IconWhispers },
  { href: "/me", key: "me", Icon: IconMe },
] as const;

const SECONDARY = [
  { href: "/match", key: "match", Icon: IconMatch },
  { href: "/learn", key: "learn", Icon: IconLearn },
  { href: "/about", key: "about", Icon: IconInfo },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function Brand() {
  return (
    <Link href="/" className="brand" aria-label="MOONA home">
      <img src="/brand/moona-logo.webp" alt="" width={32} height={32} />
      <span>MOONA</span>
    </Link>
  );
}

export function LanguageToggle() {
  const { locale, setLocale, m } = useI18n();
  return (
    <button type="button" className="chip lang-toggle" onClick={() => setLocale(locale === "en" ? "zh" : "en")} aria-label={m.common.switchLanguageLabel}>
      {m.common.switchLanguage}
    </button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { m } = useI18n();
  const current = (href: string) => (isActive(pathname, href) ? "page" : undefined);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <Brand />
        <Link href="/" className="side-link" aria-current={current("/")}><IconHome />{m.nav.home}</Link>
        {PRIMARY.map(({ href, key, Icon }) => (
          <Link key={href} href={href} className="side-link" aria-current={current(href)}><Icon />{m.nav[key]}</Link>
        ))}
        <div className="side-sep" />
        {SECONDARY.map(({ href, key, Icon }) => (
          <Link key={href} href={href} className="side-link" aria-current={current(href)}><Icon />{m.nav[key]}</Link>
        ))}
      </nav>

      <header className="topbar">
        <Brand />
        <LanguageToggle />
      </header>

      <main className="shell-main" id="main">{children}</main>

      <footer className="footer">
        <p style={{ margin: 0 }}>{m.disclaimer}</p>
        <p style={{ margin: "6px 0 0" }}><Link href="/about">{m.nav.about}</Link></p>
      </footer>

      <nav className="tabbar" aria-label="Main">
        {PRIMARY.map(({ href, key, Icon }) => (
          <Link key={href} href={href} className="tab" aria-current={current(href)}><Icon />{m.nav[key]}</Link>
        ))}
      </nav>
    </div>
  );
}
