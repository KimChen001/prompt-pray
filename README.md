# MOONA · Prompt & Pray

A cyber-mystic tarot and astrology companion, rebuilt for the web from the 2025 MOONA WeChat mini-program. Bilingual (English default, 中文), mobile and desktop.

> For reflection and entertainment. Not medical, legal, or financial advice.

## Run it

Requires Node 20.9+.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000. No environment variables are needed: everything in this build runs in the browser.

Checks:

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run check:content
```

```bash
npm run build
```

## Status (day 1 · 2026-10-08)

| Module | Route | State |
| --- | --- | --- |
| Tarot: ask → spread → shuffle → pick from fan → reveal → reading | `/tarot`, `/tarot/new`, `/tarot/r/[id]` | **Working**, offline engine |
| Daily card | `/today` | **Working** — card part; sky and horoscope scheduled Oct 14 |
| History, settings, export, clear data | `/me` | **Working** (local only) |
| Crisis detection on the question | `/tarot/new` | **Working**, keyword layer (AI layer Oct 13) |
| EN / 中文 switch | everywhere | **Working** — switching never changes cards or state |
| Birth chart (Sun/Moon/Rising) | `/chart` | Scheduled Oct 15 — page says so, shows nothing simulated |
| Learn | `/learn` | Scheduled Oct 16 |
| Match | `/match` | Scheduled Oct 17 |
| Whispers (community) | `/whispers` | Scheduled Oct 18–19 |
| AI readings | — | Oct 13, after the provider is chosen |
| Share snapshots | — | Oct 20 (needs Supabase); today: copy text and the native share sheet |

Nothing in the app is mock data. Unbuilt modules show an "In development" page with their date. Every reading shows where its text came from (`Offline engine` today; `Live AI` once AI ships).

## What was reused from the mini-program

| From (`xuanxue0817/xuanxue`) | To | Change |
| --- | --- | --- |
| `packageB/pages/tarot/tarot.js` — FNV-1a hash, mulberry32, shuffle | `src/lib/tarot/rng.ts` | Typed; live draws now seed from `crypto.getRandomValues` |
| `tarot.js` — 4 spreads and positions | `src/lib/tarot/spreads.ts` | Bilingual positions; spread suggestion from the question |
| `utils/tarotPro.js` — elements, majors ratio, patterns, A/B scoring | `src/lib/tarot/engine.ts` | Rewritten to bilingual natural language (no `火∧风` codes); A/B scoring now uses all 4 cards (plan v0.2 §3.2); deterministic (no random template picks) |
| `packageB/tarot/meanings.zh.js` (7 cards) | `content/tarot/*.json` (78 cards) | All 78 cards written fresh in EN + ZH: keywords, meaning, advice, love/work/growth, upright and reversed |
| `images/logo1.png` (actually WebP) | `public/brand/moona-logo.webp` | Renamed to its real format |
| `packageB/tarot/thumbs/card-back.jpg` | `public/cards/back.jpg` | Unchanged, **placeholder** — the team will decide the card back |
| `app.wxss` starfield | `src/app/globals.css` | Toned down for readability |

## What changed on purpose

- **Card faces** are the 1909 Rider–Waite–Smith "Roses & Lilies" scans from Wikimedia Commons (public domain, Pamela Colman Smith), fetched by `npm run fetch:cards`, resized to 400px. Every card's source URL and license is in `content/credits.json`. The mini-program's card images are not used.
- **Dates**: "today" is the user's local calendar day (`src/lib/time.ts`), never `toISOString().slice(0,10)`. Tests cover LA/NY around midnight and both US DST changeovers.
- **Daily card** is seeded per device + local date + topic, and saved once drawn, so it never changes during the day and switching language never redraws it.
- **Reversals** are a user setting (on by default, 50%).
- **The question never goes in a URL.** "Same question, new draw" passes the reading id instead.
- No API keys exist in this repo. The old Coze key from the mini-program is not carried over.

## Project layout

```
content/tarot/*.json     78 cards, EN + ZH         content/credits.json   image provenance
public/cards/            78 faces + back            scripts/               fetch-cards, check-content
src/lib/tarot/           deck, rng, spreads, engine, daily
src/lib/                 time.ts (date semantics), safety.ts (crisis), store.ts (localStorage)
src/lib/i18n/            en.ts (source of truth), zh.ts (type-checked against en)
src/app/                 routes                     src/components/        shell, card, badges
tests/                   vitest
```

## Data and privacy (this build)

Questions, readings and settings live in this browser's `localStorage` only. No accounts, analytics or server calls. If storage is blocked, readings still work for the current tab and the UI says history is off.
