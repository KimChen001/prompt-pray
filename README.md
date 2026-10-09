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

## Status (day 2 · 2026-10-09)

| Module | Route | State |
| --- | --- | --- |
| Tarot: ask → spread → shuffle → pick from fan → reveal → reading | `/tarot`, `/tarot/new`, `/tarot/r/[id]` | **Working**, offline engine |
| Daily card + Today's sky (Moon sign/phase, sign changes, stations, lunations, retrogrades) | `/today` | **Working** — sky checked against Swiss Ephemeris for all of 2026; horoscope Oct 10 |
| History, settings, export, clear data | `/me` | **Working** (local only) |
| Crisis detection on the question | `/tarot/new` | **Working**, keyword layer (AI layer Oct 13) |
| EN / 中文 switch | everywhere | **Working** — switching never changes cards or state |
| Birth chart: birth form, place search, Big Three, planets, angles, houses | `/chart`, `/chart/edit`, `/api/places` | **Working** — real calculation, unknown-time rules; wheel + interpretations pending (UI design from the team, content Oct 16) |
| Learn | `/learn` | Scheduled Oct 16 |
| Match | `/match` | Scheduled Oct 17 |
| Whispers (community) | `/whispers` | Scheduled Oct 18–19 |
| AI readings | — | Oct 13, after the provider is chosen |
| Share snapshots | — | Oct 20 (needs Supabase); today: copy text and the native share sheet |

Nothing in the app is mock data. Unbuilt modules show an "In development" page with their date. Every reading shows where its text came from (`Offline engine` today; `Live AI` once AI ships).

## Astrology engine

- Positions: [astronomy-engine](https://github.com/cosinekitty/astronomy) (MIT), computed in the browser (`src/lib/astro/ephemeris.ts`).
- Ascendant, Midheaven, Placidus and Whole Sign houses: `src/lib/astro/houses.ts`. Placidus falls back to Whole Sign above ~66.6° latitude, with a notice.
- Birth time → UTC: `src/lib/astro/birth.ts`, using the browser's IANA history (DST, pre-1970 rules, half-hour zones). Times that happened twice (fall back) ask the user; times that never happened (spring forward) are flagged with the shifted time.
- Unknown birth time (`src/lib/astro/chart.ts`): no Rising, no houses; Sun/Moon show both signs and the local change time when they change sign that day.
- **Today's sky** (`src/lib/astro/sky.ts`): events are assigned to the user's local day. `tests/fixtures/sky-2026.sweph.json` covers every 2026 new/full moon (< 5 min), Sun ingress (< 5 min) and Mercury/Venus station (< 3 h; stations are inherently soft).
- **Accuracy check:** `tests/fixtures/charts.sweph.json` holds 8 reference charts (US east/west, Shanghai, Kolkata, Sydney, London 1965, Reykjavik, Cambridge 2026) generated with Swiss Ephemeris 2.10 outside this repo (`scripts/oracle/` regenerates them). Swiss Ephemeris is not a dependency (AGPL); it is only the test oracle. Current tolerances: planets and angles < 0.02°, Placidus cusps < 0.05°.
- Places: GeoNames cities5000 (CC BY 4.0), 69,780 places with IANA zones and Chinese aliases, built by `npm run build:places` into `data/places.json` and searched server-side by `/api/places` (the query is not logged).

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
| `services/astro.js` (random Moon/Rising) | — | **Not reused.** Replaced by real calculation in `src/lib/astro/` |
| `data/zodiac-signs.js` | `src/lib/astro/zodiac.ts` | Rebuilt bilingual sign table |

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
src/lib/astro/           ephemeris, houses, birth (time zones), chart (Big Three), places (search)
data/places.json         GeoNames places (generated)
src/lib/i18n/            en.ts (source of truth), zh.ts (type-checked against en)
src/app/                 routes                     src/components/        shell, card, badges
tests/                   vitest
```

## Data and privacy (this build)

Questions, readings, settings and birth details live in this browser's `localStorage` only. The chart is calculated in the browser. The only server call is the birthplace search (`/api/places`), which receives the typed city name and nothing else. No accounts or analytics. If storage is blocked, readings still work for the current tab and the UI says history is off.
