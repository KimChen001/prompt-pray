"use client";
import { useI18n } from "@/lib/i18n";
import { DevModule } from "@/components/bits";

export default function Page() {
  const { m, locale } = useI18n();
  return <DevModule module={m.nav.learn} date={locale === "zh" ? "10月13日" : "Oct 13"} points={m.dev.learn} />;
}
