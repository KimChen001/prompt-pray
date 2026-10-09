"use client";
// Site header and footer (Figma: "Navigation / Header"). Desktop: wordmark + text nav; phones: wordmark
// + menu button. The design names five destinations; Learn, Match, Whispers and About sit under "More"
// so every built section stays reachable.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";

const PRIMARY = [
  { href: "/", key: "home" },
  { href: "/chart", key: "natalChart" },
  { href: "/tarot", key: "tarot" },
  { href: "/today", key: "guidance" },
  { href: "/me", key: "journal" },
] as const;

const MORE = [
  { href: "/learn", key: "learn" },
  { href: "/match", key: "match" },
  { href: "/whispers", key: "whispers" },
  { href: "/about", key: "about" },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
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
  const [menuOpen, setMenuOpen] = useState(false);
  const current = (href: string) => (isActive(pathname, href) ? "page" : undefined);

  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <div className="shell">
      <header className="site-header">
        <div className="site-header-inner">
          <div className="site-header-row">
            <Link href="/" className="wordmark" aria-label="MOONA home">MOONA</Link>
            <nav className="site-nav" aria-label="Main">
              {PRIMARY.map(({ href, key }) => (
                <Link key={href} href={href} aria-current={current(href)}>{m.nav[key]}</Link>
              ))}
              <details className="nav-more" key={pathname}>
                <summary>{m.nav.more}</summary>
                <div className="nav-more-panel">
                  {MORE.map(({ href, key }) => (
                    <Link key={href} href={href} aria-current={current(href)}>{m.nav[key]}</Link>
                  ))}
                </div>
              </details>
            </nav>
            <div className="header-actions">
              <LanguageToggle />
              <button type="button" className="menu-btn" aria-expanded={menuOpen} aria-controls="mobile-menu" aria-label={m.nav.menu} onClick={() => setMenuOpen((o) => !o)}>
                ☰
              </button>
            </div>
          </div>
          {menuOpen && (
            <nav className="mobile-menu" id="mobile-menu" aria-label="Main">
              {[...PRIMARY, ...MORE].map(({ href, key }) => (
                <Link key={href} href={href} aria-current={current(href)}>{m.nav[key]}</Link>
              ))}
            </nav>
          )}
          <hr className="hairline" />
        </div>
      </header>

      <main className="shell-main" id="main">{children}</main>

      <footer className="footer">
        <p style={{ margin: 0 }}>{m.disclaimer}</p>
        <Link href="/about">{m.nav.about}</Link>
        <p className="footer-tagline">{m.nav.tagline}</p>
      </footer>
    </div>
  );
}
