"use client";
// Site shell. Desktop: wordmark + text navigation (Figma "Navigation / Header") with Learn, Match,
// Whispers and About under "More". Phones: wordmark + menu sheet, plus a bottom tab bar
// (Home · Today · Tarot · Chart · Journal, design supplement §4). Talk with MOONA, Learn, Match and
// Whispers stay one tap away in the menu and on the home page — nothing is dropped on phones.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { setMotionPref, useMotionPref, type MotionPref } from "@/lib/motion";
import { Icon, type IconName } from "./icons";

type NavKey = "home" | "natalChart" | "tarot" | "talk" | "guidance" | "journal" | "learn" | "match" | "whispers" | "about" | "today" | "chart";

const PRIMARY: { href: string; key: NavKey }[] = [
  { href: "/", key: "home" },
  { href: "/chart", key: "natalChart" },
  { href: "/tarot", key: "tarot" },
  { href: "/talk", key: "talk" },
  { href: "/today", key: "guidance" },
  { href: "/me", key: "journal" },
];

const MORE: { href: string; key: NavKey; icon: IconName }[] = [
  { href: "/learn", key: "learn", icon: "learn" },
  { href: "/match", key: "match", icon: "match" },
  { href: "/whispers", key: "whispers", icon: "whispers" },
  { href: "/about", key: "about", icon: "about" },
];

const MENU: { href: string; key: NavKey; icon: IconName }[] = [
  { href: "/", key: "home", icon: "home" },
  { href: "/tarot", key: "tarot", icon: "tarot" },
  { href: "/talk", key: "talk", icon: "talk" },
  { href: "/chart", key: "natalChart", icon: "chart" },
  { href: "/today", key: "guidance", icon: "today" },
  { href: "/me", key: "journal", icon: "journal" },
];

const TABS: { href: string; key: NavKey; icon: IconName; accent?: boolean }[] = [
  { href: "/", key: "home", icon: "home" },
  { href: "/today", key: "today", icon: "today" },
  { href: "/tarot", key: "tarot", icon: "tarot", accent: true },
  { href: "/chart", key: "chart", icon: "chart" },
  { href: "/me", key: "journal", icon: "journal" },
];

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

/** Motion: Auto (follows the system setting) · Reduced (still frames) · Off (no animated orb). */
export function MotionSetting({ compact }: { compact?: boolean }) {
  const { m } = useI18n();
  const pref = useMotionPref();
  const options: MotionPref[] = ["auto", "reduced", "off"];
  return (
    <div className="row" style={{ gap: 10 }}>
      {!compact && <span className="muted small" id="motion-label">{m.motion.label}</span>}
      <div className="seg" role="group" aria-labelledby={compact ? undefined : "motion-label"} aria-label={compact ? m.motion.label : undefined}>
        {options.map((o) => (
          <button key={o} type="button" aria-pressed={pref === o} onClick={() => setMotionPref(o)}>{m.motion[o]}</button>
        ))}
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { m } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const current = (href: string) => (isActive(pathname, href) ? "page" : undefined);

  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="shell has-tabbar">
      <a href="#main" className="skip-link">{m.nav.skip}</a>
      <header className="site-header">
        <div className="site-header-inner">
          <div className="site-header-row">
            <Link href="/" className="wordmark" aria-label={m.nav.homeLabel}>
              <img src="/brand/moona-mark.svg" alt="" width={28} height={28} />
              MOONA
            </Link>
            <nav className="site-nav" aria-label={m.nav.mainLabel}>
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
              <button type="button" className="menu-btn" aria-expanded={menuOpen} aria-controls="mobile-menu" aria-label={menuOpen ? m.nav.close : m.nav.menu} onClick={() => setMenuOpen((o) => !o)}>
                <Icon name={menuOpen ? "close" : "menu"} />
              </button>
            </div>
          </div>
          {menuOpen && (
            <nav className="mobile-menu" id="mobile-menu" aria-label={m.nav.mainLabel}>
              {MENU.map(({ href, key, icon }) => (
                <Link key={href} href={href} aria-current={current(href)}>
                  <span className="row" style={{ gap: 14 }}><Icon name={icon} size={20} />{m.nav[key]}</span>
                </Link>
              ))}
              <p className="eyebrow menu-group">{m.nav.more}</p>
              {MORE.map(({ href, key, icon }) => (
                <Link key={href} href={href} aria-current={current(href)}>
                  <span className="row" style={{ gap: 14 }}><Icon name={icon} size={20} />{m.nav[key]}</span>
                </Link>
              ))}
              <div className="menu-foot">
                <MotionSetting />
              </div>
            </nav>
          )}
          <hr className="hairline" />
        </div>
      </header>

      <main className="shell-main" id="main">{children}</main>

      <footer className="footer">
        <p style={{ margin: 0, maxWidth: "60ch" }}>{m.disclaimer}</p>
        <div className="footer-row">
          <Link href="/about">{m.nav.about}</Link>
          <MotionSetting />
        </div>
        <p className="footer-tagline">{m.nav.tagline}</p>
      </footer>

      <nav className="tabbar" aria-label={m.nav.tabsLabel}>
        {TABS.map(({ href, key, icon, accent }) => (
          <Link key={href} href={href} aria-current={current(href)} aria-label={m.nav[key]} data-accent={accent ? "true" : undefined}>
            {accent ? <span className="tab-orb"><Icon name={icon} size={20} /></span> : <Icon name={icon} />}
            <span>{m.nav[key]}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
