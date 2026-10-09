"use client";
import { useI18n } from "@/lib/i18n";
import { DevModule } from "@/components/bits";

export default function Page() {
  const { m, locale } = useI18n();
  return <DevModule module={m.nav.whispers} date={locale === "zh" ? "10月18日" : "Oct 18"} points={m.dev.whispers} />;
}
