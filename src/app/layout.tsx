import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import "@fontsource-variable/inter";
import "@fontsource/cormorant-garamond/500.css";
import "@fontsource/cormorant-garamond/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "./globals.css";
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
export const viewport: Viewport = { themeColor: "#0e0d16", width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content" };

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
