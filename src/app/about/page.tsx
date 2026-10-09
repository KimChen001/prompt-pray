"use client";
// About: what the source labels mean, exactly what leaves the device, what is and isn't built,
// and where every asset comes from.
import { useI18n } from "@/lib/i18n";

export default function AboutPage() {
  const { m } = useI18n();
  const a = m.about;
  return (
    <div className="stack gap-12" style={{ maxWidth: 860 }}>
      <header className="about-head">
        <div className="page-head">
          <p className="eyebrow">MOONA</p>
          <h1 className="h1">{a.title}</h1>
          <p className="lede">{a.intro}</p>
        </div>
        <img src="/brand/moona-wheel.svg" alt="" width={220} height={220} className="about-wheel" />
      </header>

      <section className="stack gap-3" aria-labelledby="labels-title">
        <h2 className="h2" id="labels-title">{a.labelsTitle}</h2>
        <dl className="about-list">
          {a.labels.map(([k, v]) => (
            <div key={k}><dt><span className="badge">{k}</span></dt><dd>{v}</dd></div>
          ))}
        </dl>
      </section>

      <section className="stack gap-3" aria-labelledby="sent-title">
        <h2 className="h2" id="sent-title">{a.sentTitle}</h2>
        <ul className="prose" style={{ margin: 0, paddingLeft: 20, color: "var(--text-2)" }}>
          {a.sent.map((s) => <li key={s} style={{ marginBottom: 8 }}>{s}</li>)}
        </ul>
        <p className="notice-quiet">{a.sentNote}</p>
      </section>

      <section className="stack gap-3" aria-labelledby="status-title">
        <h2 className="h2" id="status-title">{a.statusTitle}</h2>
        <dl className="about-list">
          {a.status.map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      </section>

      <section className="stack gap-3" aria-labelledby="sources-title">
        <h2 className="h2" id="sources-title">{a.sourcesTitle}</h2>
        <ul className="prose" style={{ margin: 0, paddingLeft: 20, color: "var(--text-2)" }}>
          {a.sources.map((s) => <li key={s} style={{ marginBottom: 8 }}>{s}</li>)}
        </ul>
      </section>
    </div>
  );
}
