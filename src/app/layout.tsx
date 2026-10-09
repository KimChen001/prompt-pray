import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
// The prototype's type: Instrument Serif (headlines), Geist (text), Geist Mono (labels), and for the
// whispers Cinzel (inscription) over Pinyon Script. All SIL Open Font License, served from this site.
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/geist";
import "@fontsource/geist-mono/400.css";
import "@fontsource/cinzel/400.css";
import "@fontsource/pinyon-script/400.css";
import "./styles.css";
import { I18nProvider } from "@/lib/i18n";
import { LOCALE_COOKIE, toLocale } from "@/lib/i18n/config";
import { MOTION_BOOT_SCRIPT } from "@/lib/motion-boot";
import { AppShell } from "@/components/AppShell";
import { ServiceWorker } from "@/components/ServiceWorker";

export const metadata: Metadata = {
  title: "MOONA — tarot, your chart, and a companion that remembers",
  description: "Draw your own cards, see your real birth chart, and talk it through. A reflective tarot and astrology companion. No sign-up.",
  icons: { icon: [{ url: "/brand/moona-mark.svg", type: "image/svg+xml" }, { url: "/icons/favicon-48.png", sizes: "48x48" }], apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "MOONA", statusBarStyle: "black-translucent" },
};

// viewportFit=cover exposes the safe-area insets (tab bar, notches); resizes-content keeps the chat
// box above the on-screen keyboard on Android Chrome (iOS scrolls the focused field into view).
export const viewport: Viewport = { themeColor: "#07060c", width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = toLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return (
    <html lang={locale === "zh" ? "zh-CN" : "en"} data-motion="reduced" suppressHydrationWarning>
      <head>
        {/* Applies the saved motion preference before first paint (no animation flash). */}
        <script dangerouslySetInnerHTML={{ __html: MOTION_BOOT_SCRIPT }} />
      </head>
      <body>
        <I18nProvider initialLocale={locale}>
          <AppShell>{children}</AppShell>
          <ServiceWorker />
        </I18nProvider>
      </body>
    </html>
  );
}
