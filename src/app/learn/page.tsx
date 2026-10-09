"use client";
import { useI18n } from "@/lib/i18n";
import { DevModule } from "@/components/bits";

export default function Page() {
  const { m, locale } = useI18n();
  return <DevModule module={m.nav.learn} date={locale === "zh" ? "10月16日" : "Oct 16"} points={m.dev.learn} />;
}
