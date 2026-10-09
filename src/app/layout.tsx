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
import { AppShell } from "@/components/AppShell";
import { ServiceWorker } from "@/components/ServiceWorker";

export const metadata: Metadata = {
  title: "MOONA — Ask the cards",
  description: "A cyber-mystic tarot and astrology companion. Draw your own cards and get a reading that answers your question.",
  icons: { icon: "/icons/favicon-48.png", apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "MOONA", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = { themeColor: "#0b0c10", width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = toLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return (
    <html lang={locale === "zh" ? "zh-CN" : "en"}>
      <body>
        <I18nProvider initialLocale={locale}>
          <AppShell>{children}</AppShell>
          <ServiceWorker />
        </I18nProvider>
      </body>
    </html>
  );
}
