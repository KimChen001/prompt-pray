"use client";
// Site shell, ported from the team's Figma Make prototype (github.com/KimChen001/Moona, App.tsx):
// the full-screen starfield, a left rail on desktop that widens on hover, a bottom tab bar on phones,
// and the Moon-phase badge. Navigation is the prototype's four sections — Ask (home), Cards (tarot),
// Sky (today's sky, horoscope and birth chart), Journal — plus "More" so Learn, Match, Whispers and
// About stay one tap away.
// Not copied from the prototype: its sign-in was a mock (it "signed in" a sample user). Accounts don't
// exist yet, so the account entry opens an honest panel: everything is saved on this device.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BookOpen, Feather, Info, Menu, MessageCircle, Moon, Orbit, QrCode, Sparkles, User, Users, X as Close, CircleDot } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { setMotionPref, useMotionPref, type MotionPref } from "@/lib/motion";
import { exportLocalData } from "@/lib/store";
import { Cosmos } from "./cosmos/Cosmos";
import { MoonBadge } from "./cosmos/MoonBadge";
import { PhoneQr } from "./PhoneQr";

type NavKey = "ask" | "cards" | "sky" | "journal";
const NAV: { key: NavKey; href: string; icon: typeof MessageCircle; match: RegExp }[] = [
  { key: "ask", href: "/", icon: MessageCircle, match: /^\/($|talk(\/|$))/ },
  { key: "cards", href: "/tarot", icon: Sparkles, match: /^\/tarot(\/|$)/ },
  { key: "sky", href: "/today", icon: Orbit, match: /^\/(today|chart)(\/|$)/ },
  { key: "journal", href: "/me", icon: Feather, match: /^\/me(\/|$)/ },
];
type MoreKey = "chart" | "learn" | "match" | "whispers" | "about";
const MORE: { key: MoreKey; href: string; icon: typeof MessageCircle }[] = [
  { key: "chart", href: "/chart", icon: CircleDot },
  { key: "learn", href: "/learn", icon: BookOpen },
  { key: "match", href: "/match", icon: Users },
  { key: "whispers", href: "/whispers", icon: Moon },
  { key: "about", href: "/about", icon: Info },
];

export function Logo({ withText = true }: { withText?: boolean }) {
  return (
    <span className="flex items-center gap-3">
      <span className="relative h-6 w-6 shrink-0 overflow-hidden rounded-full border border-white/40">
        <span className="absolute inset-[3px] translate-x-[4px] rounded-full bg-[#07060c] ring-1 ring-white/0" />
      </span>
      {withText && <span className="font-serif-i text-xl tracking-[0.35em]">MOONA</span>}
    </span>
  );
}

export function LanguageToggle({ className = "" }: { className?: string }) {
  const { locale, setLocale, m } = useI18n();
  return (
    <button type="button" onClick={() => setLocale(locale === "en" ? "zh" : "en")} aria-label={m.common.switchLanguageLabel}
      className={`rounded-full px-3 py-1.5 font-mono-g text-[11px] text-white/55 transition-colors hover:text-white ${className}`}>
      {m.common.switchLanguage}
    </button>
  );
}

/** Motion: Auto (follows the system's reduced-motion setting) · Reduced (still frames) · Off. */
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

function Rail({ pathname, onAccount, onQr }: { pathname: string; onAccount: () => void; onQr: () => void }) {
  const { m } = useI18n();
  const [open, setOpen] = useState(false);
  const fade = `whitespace-nowrap text-sm transition-opacity duration-300 ${open ? "opacity-100 delay-100" : "opacity-0"}`;
  const item = (on: boolean) => `relative flex w-full items-center gap-4 px-[24px] py-3 text-left no-underline transition-colors ${on ? "text-white" : "text-white/45 hover:text-white"}`;
  return (
    <nav
      aria-label={m.nav.mainLabel}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}
      className={`fixed left-0 top-0 z-40 hidden h-full flex-col overflow-hidden border-r border-white/[0.06] bg-[#07060c]/60 py-7 backdrop-blur-xl transition-[width] duration-500 ease-[cubic-bezier(.2,.8,.2,1)] lg:flex ${open ? "w-56" : "w-[68px]"}`}
    >
      <Link href="/" className="mb-14 px-[21px] no-underline" aria-label={m.nav.homeLabel}>
        <span className="flex items-center gap-3">
          <Logo withText={false} />
          <span className={`font-serif-i text-xl tracking-[0.35em] transition-opacity duration-300 ${open ? "opacity-100" : "opacity-0"}`}>MOONA</span>
        </span>
      </Link>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {NAV.map(({ key, href, icon: Icon, match }) => {
          const on = match.test(pathname);
          return (
            <li key={key}>
              <Link href={href} aria-current={on ? "page" : undefined} className={item(on)}>
                <span className={`absolute left-0 top-1/2 h-5 w-px -translate-y-1/2 bg-[#c9a96e] transition-opacity ${on ? "opacity-100" : "opacity-0"}`} />
                <Icon size={18} strokeWidth={1.25} className="shrink-0" aria-hidden="true" />
                <span className={fade}>{m.cosmos.nav[key]}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <p className={`mb-1 mt-8 px-[24px] font-mono-g text-[10px] uppercase tracking-[0.25em] text-white/30 ${fade}`}>{m.nav.more}</p>
      <ul className="m-0 flex list-none flex-col p-0">
        {MORE.map(({ key, href, icon: Icon }) => {
          const on = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={key}>
              <Link href={href} aria-current={on ? "page" : undefined} className={`${item(on)} py-2.5`}>
                <span className={`absolute left-0 top-1/2 h-5 w-px -translate-y-1/2 bg-[#c9a96e] transition-opacity ${on ? "opacity-100" : "opacity-0"}`} />
                <Icon size={16} strokeWidth={1.25} className="shrink-0" aria-hidden="true" />
                <span className={fade}>{m.cosmos.more[key]}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto flex flex-col gap-1 px-[18px]">
        <button type="button" onClick={onQr} className="flex w-full items-center gap-3 rounded-full py-1.5 pl-[7px] text-left text-white/45 transition-colors hover:text-white">
          <QrCode size={17} strokeWidth={1.25} className="shrink-0" aria-hidden="true" />
          <span className={fade}>{m.qr.title}</span>
        </button>
        <button type="button" onClick={onAccount} className="flex w-full items-center gap-3 rounded-full py-1.5 text-left text-white/55 transition-colors hover:text-white">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-dashed border-white/30"><User size={15} strokeWidth={1.25} aria-hidden="true" /></span>
          <span className={fade}>{m.cosmos.account}</span>
        </button>
      </div>
    </nav>
  );
}

function TabBar({ pathname, onMore }: { pathname: string; onMore: () => void }) {
  const { m } = useI18n();
  return (
    <nav aria-label={m.nav.tabsLabel} className="cosmos-tabbar fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.06] bg-[#07060c]/80 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
      <ul className="m-0 mx-auto grid max-w-md list-none grid-cols-5 p-0">
        {NAV.map(({ key, href, icon: Icon, match }) => {
          const on = match.test(pathname);
          return (
            <li key={key}>
              <Link href={href} aria-current={on ? "page" : undefined} className={`relative flex w-full flex-col items-center gap-1 py-2.5 no-underline transition-colors ${on ? "text-white" : "text-white/40"}`}>
                <span className={`absolute top-0 h-px w-6 bg-[#c9a96e] transition-opacity ${on ? "opacity-100" : "opacity-0"}`} />
                <Icon size={19} strokeWidth={1.25} aria-hidden="true" />
                <span className="text-[10px] tracking-wide">{m.cosmos.nav[key]}</span>
              </Link>
            </li>
          );
        })}
        <li>
          <button type="button" onClick={onMore} className="relative flex w-full flex-col items-center gap-1 py-2.5 text-white/40 transition-colors">
            <Menu size={19} strokeWidth={1.25} aria-hidden="true" />
            <span className="text-[10px] tracking-wide">{m.nav.more}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}

/** A dialog in the prototype's sign-in style (bottom sheet on phones, centred card on desktop). */
function Sheet({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const { m } = useI18n();
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 grid place-items-end bg-[#07060c]/50 backdrop-blur-sm sm:place-items-center"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div role="dialog" aria-modal="true" aria-label={label}
            onClick={(e) => e.stopPropagation()}
            initial={{ y: 30, opacity: 0, filter: "blur(8px)" }} animate={{ y: 0, opacity: 1, filter: "blur(0px)" }} exit={{ y: 20, opacity: 0 }}
            transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
            className="relative max-h-[90dvh] w-full max-w-[440px] overflow-y-auto rounded-t-[28px] border border-white/[0.08] bg-[#0d0b16]/90 p-7 pb-[calc(1.75rem+env(safe-area-inset-bottom))] shadow-[0_40px_120px_-30px_rgba(120,105,235,0.35)] backdrop-blur-2xl sm:rounded-[28px] sm:pb-7">
            <button type="button" onClick={onClose} aria-label={m.share.close} className="absolute right-5 top-5 text-white/35 transition-colors hover:text-white"><Close size={16} strokeWidth={1.25} /></button>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function download() {
  const blob = new Blob([exportLocalData()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "moona-data.json";
  a.click();
  URL.revokeObjectURL(url);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { m } = useI18n();
  const [sheet, setSheet] = useState<"account" | "more" | "qr" | null>(null);
  const isAsk = pathname === "/";
  const close = () => setSheet(null);

  useEffect(() => setSheet(null), [pathname]);

  const pill = "flex w-full items-center justify-center gap-3 rounded-full border border-white/10 bg-white/[0.04] py-3 text-[14px] text-[#ece8f4] no-underline transition-colors hover:border-white/25 hover:bg-white/[0.07]";

  return (
    <div className={`cosmos-shell relative min-h-[100dvh] bg-[#07060c] text-[#ece8f4] selection:bg-[#c9a96e]/30 ${isAsk ? "h-[100dvh] overflow-hidden" : ""}`}>
      <a href="#main" className="skip-link">{m.nav.skip}</a>
      <Cosmos calm={!isAsk} />
      <Rail pathname={pathname} onAccount={() => setSheet("account")} onQr={() => setSheet("qr")} />
      <TabBar pathname={pathname} onMore={() => setSheet("more")} />

      <div className={`relative z-10 flex flex-col pb-[calc(58px+env(safe-area-inset-bottom))] lg:pb-0 lg:pl-[68px] ${isAsk ? "h-full" : "min-h-[100dvh]"}`}>
        <header className="flex items-center justify-between px-5 pt-5 sm:px-8">
          <Link href="/" className="no-underline lg:invisible" aria-label={m.nav.homeLabel}><Logo /></Link>
          <div className="flex items-center gap-1">
            <MoonBadge />
            <LanguageToggle />
            <button type="button" onClick={() => setSheet("account")} aria-label={m.cosmos.account}
              className="grid h-8 w-8 place-items-center rounded-full text-white/55 lg:hidden">
              <User size={17} strokeWidth={1.25} />
            </button>
          </div>
        </header>

        {isAsk ? (
          <main id="main" className="flex min-h-0 flex-1 flex-col">{children}</main>
        ) : (
          <>
            <main id="main" className="shell-main">{children}</main>
            <footer className="footer">
              <p style={{ margin: 0, maxWidth: "60ch" }}>{m.disclaimer}</p>
              <div className="footer-row">
                <Link href="/about">{m.nav.about}</Link>
                <MotionSetting />
              </div>
            </footer>
          </>
        )}
      </div>

      <Sheet open={sheet === "account"} onClose={close} label={m.cosmos.account}>
        <Logo withText={false} />
        <h2 className="mt-6 font-serif-i text-[34px] leading-[1.05]">{m.cosmos.keepTitle} <em className="text-white/55">{m.cosmos.keepEm}</em></h2>
        <p className="mt-3 text-[14px] leading-relaxed text-white/60">{m.cosmos.keepBody}</p>
        <div className="mt-7 space-y-2.5">
          <Link href="/me" className={pill} onClick={close}><Feather size={15} strokeWidth={1.25} aria-hidden="true" />{m.cosmos.openJournal}</Link>
          <button type="button" className={pill} onClick={download}>{m.me.export}</button>
        </div>
        <p className="mt-5 text-center text-[11px] text-white/35">{m.cosmos.keepNote}</p>
      </Sheet>

      <Sheet open={sheet === "more"} onClose={close} label={m.nav.more}>
        <p className="font-mono-g text-[10px] uppercase tracking-[0.25em] text-white/35">{m.nav.more}</p>
        <ul className="m-0 mt-4 flex list-none flex-col p-0">
          {MORE.map(({ key, href, icon: Icon }) => (
            <li key={key}>
              <Link href={href} onClick={close} className="flex items-center gap-4 border-b border-white/[0.06] py-3.5 text-[16px] text-white/75 no-underline">
                <Icon size={18} strokeWidth={1.25} aria-hidden="true" />{m.cosmos.more[key]}
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-6"><MotionSetting /></div>
      </Sheet>

      <Sheet open={sheet === "qr"} onClose={close} label={m.qr.title}>
        <PhoneQr open />
      </Sheet>
    </div>
  );
}
