"use client";
import { useI18n } from "@/lib/i18n";

export default function AboutPage() {
  const { m } = useI18n();
  return (
    <div className="stack gap-32 prose">
      <div className="stack gap-12">
        <h1 className="h1">{m.about.title}</h1>
        <p className="lede">{m.about.intro}</p>
      </div>
      <section className="stack gap-8">
        <h2 className="h2">{m.about.cardsTitle}</h2>
        <p style={{ margin: 0 }}>
          {m.about.cards}{" "}
          <a href="https://commons.wikimedia.org/wiki/Category:Rider-Waite_tarot_deck_(Roses_%26_Lilies)" target="_blank" rel="noreferrer">Wikimedia Commons</a>
        </p>
        <p className="muted small" style={{ margin: 0 }}>{m.about.backNote}</p>
      </section>
      <section className="stack gap-8">
        <h2 className="h2">{m.about.dataTitle}</h2>
        <p style={{ margin: 0 }}>{m.about.data}</p>
      </section>
      <section className="stack gap-8">
        <h2 className="h2">{m.about.privacyTitle}</h2>
        <p style={{ margin: 0 }}>{m.about.privacy}</p>
      </section>
      <p className="muted small" style={{ margin: 0 }}>{m.disclaimer}</p>
    </div>
  );
}
