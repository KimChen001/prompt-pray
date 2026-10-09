# MOONA · Prompt & Pray

A reflective tarot and astrology companion for the web: draw your own cards, see your real birth chart, and talk it through with MOONA. One responsive site for desktop (demo screen) and phones (visitors scan a QR code; no app, no sign-up). English by default, 中文 everywhere.

> For reflection and entertainment. Not medical, legal, or financial advice.

## Run it

Requires Node 20.9+.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000. No environment variables are needed: without an AI key every AI feature shows its offline / template / library text, labelled as such.

| Command | What it does |
| --- | --- |
| `npm run build` then `npm start` | Production build (needed to test the service worker / offline mode) |
| `npm test` | Vitest (518 tests) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:content` | 78 cards × 2 sides × 2 languages, images and credits, Learn entries |
| `node scripts/mock-ai.mjs 3999` | **Dev only.** Fake OpenAI-compatible endpoint returning `[MOCK]` text in every shape MOONA expects; `MOCK_DELAY_MS=1500` simulates a slow model. Run the app with `AI_API_KEY=mock AI_BASE_URL=http://127.0.0.1:3999/v1 AI_MODEL=mock-model`. Never cite its output as AI quality. |
| `node scripts/make-brand.mjs` | Regenerates the zodiac wheel and app icons from the project's SVGs |
| `npm run eval:build` / `eval:run` / `eval:blind` | Evaluation set (28 cases) for comparing real providers — see `eval/README.md` |

### AI (optional)

Copy `.env.example` to `.env.local`, set `AI_PROVIDER` and paste your own key into `AI_API_KEY`, then restart. The key stays on the server. Each provider has its own adapter (`src/lib/ai/providers/`) and parameters (`src/lib/ai/capabilities.ts`). MIT Parley is for development only; the demo uses a separately bought key.

Spend is capped by a ledger (`.data/ai-usage.json`): every request attempt reserves its maximum estimated cost before calling the provider and settles against reported usage; unknown-billing failures keep their reservation. SDK retries are off (`maxRetries: 0`) so no attempt goes unaccounted. Public deployments should set `AI_ACCESS_CODE` (only devices that entered it in Journal → Settings use AI) and a spend limit in the provider dashboard.

### QR code for the demo

The desktop home page has a "Try it on your phone" panel. Set `NEXT_PUBLIC_SITE_URL` to the deployed HTTPS address; without it the page's own address is used and labelled **test address** (or **this computer only** for `localhost`). The code always encodes the site root only — never a question, birth details, reading id, key or access code.

## Status (2026-10-09, round 2 + Figma prototype shell)

"Built" means implemented and verified with unit tests and a production build in a headless browser (mock AI). **No real model has been called yet**; real-model quality is unverified until the eval runs on bought credit. No real-device (iPhone / Android) testing has been done yet.

| Module | Route | State |
| --- | --- | --- |
| Ask (home, from the Figma Make prototype): starfield, Ether orb, whispers, Moon badge; three prompts (real daily card, tonight's Moon calculated, a real one-card reading) and a real Talk conversation; greeting from saved records | `/` | Built (typed replies need AI; without it MOONA says so and offers a card) |
| Shell (prototype): desktop rail (Ask · Cards · Sky · Journal + More), phone tab bar, account panel (honest: saved on this device, no sign-in), QR dialog | all pages | Built |
| Tarot: ask → spread → shuffle (orb gathers) → pick → turn over → one-line messages → full reading on request → Why this reading → reflection → continue with these cards → check-in | `/tarot`, `/tarot/new`, `/tarot/r/[id]` | Built (AI with offline fallback) |
| Talk with MOONA: free conversations; chart / today's sky / notes only if ticked; replies cite what they used | `/talk`, `/talk/c/[id]` | Built (needs AI to reply) |
| Memory: suggested only from your own words, saved only on confirm; edit, pause, delete; source shown | Journal, Talk, readings | Built |
| Today: daily card, horoscope (template or AI, facts checked on the server), live sky | `/today` | Built |
| Birth chart: birth details, Big Three, wheel, planets, house cusps, AI report with versions | `/chart`, `/chart/edit`, `/chart/reveal` | Built |
| Journal: readings, conversations, memory, check-ins, matches, saved, settings, export / clear | `/me` | Built (device only, no sync) |
| Learn: 121 entries, EN/ZH search, favourites, "in your chart" | `/learn` | Built |
| Match (two people on one device) | `/match`, `/match/r/[id]` | Built; **invite links need a server — planned** |
| Sharing (image + text, same preview and defaults) | readings, today, chart, match | Built on device; **revocable share links need a server — planned** |
| Whispers: private writing on the device | `/whispers` | Built; **shared wall not live** (needs server, moderation, decisions) |
| Offline / install (PWA) | `public/sw.js`, `/offline` | Built; installing is optional |
| Accounts and sync | — | **Not built.** Records stay on the device where they were made |

## How the AI is kept honest

- **Facts first.** Charts, transits and card meanings are computed or looked up by MOONA; the model only puts them into words.
- **Checked output.** Every reply is validated before it is shown or saved: tarot (only the drawn cards, orientation kept), natal report (each theme cites only its own facts), horoscope (the server recomputes the day's sky from date + time zone, refuses facts that don't match, writes the prompt sentences itself), Talk (basis ids must be ones it was given). A shared checker (`src/lib/ai/claims.ts`) rejects sign / house / aspect / Rising claims that contradict the facts, in English and Chinese, including phrasings like "Your Sun is in …" and "太阳是…". It is a backstop for common phrasings, not a proof of every sentence.
- **Labels.** Live AI · AI · saved (with time) · Offline engine · Template · Library · Calculated · Live sky · You said. Saved text is never shown as live and is never silently regenerated.
- **Unknown birth time** carries through everything: no Rising, no houses; Sun / Moon show both signs on a sign-change day; horoscope aspects to the natal Moon/Sun count only if they hold all day; houses become solar houses and say so.
- **One message contract** for all chats (`src/lib/chat/limits.ts`): history trimmed on whole messages, always starting with the person; replies the server accepted always fit back into the next request.
- **Late responses can't overwrite or resurrect.** Records are changed through field-level patches on the latest copy (`patchReading`, `patchChat`); a reply is appended only if the message it answers is still the newest; clearing data or changing birth details moves a data epoch that drops older results.

## Look and motion

The interface is the team's own Figma Make prototype ([KimChen001/Moona](https://github.com/KimChen001/Moona), `src/app/App.tsx`), ported into this Next.js app rather than rebuilt: `src/components/cosmos/` (Cosmos starfield, Orb, ShaderCanvas, Whispers, MoonBadge, StateOrb) and `src/components/AppShell.tsx` (Rail, TabBar, sheets), styled with Tailwind v4 utilities plus the site's own CSS (`src/app/styles.css` layers Tailwind's theme and utilities around `globals.css`; Tailwind's preflight is not used). Fonts: Instrument Serif, Geist, Geist Mono, Cinzel, Pinyon Script.

What changed from the prototype: its mocks are replaced by real features (the daily card, the calculated Moon, saved readings, Talk); its fake sign-in is replaced by an honest "saved on this device" panel; the Moon badge uses the real ephemeris; Chinese whispers and copy were added; Motion is honoured everywhere: Auto (follows the system's reduced-motion setting) · Reduced (still frames) · Off (no starfield, static orb) — in the footer, the More sheet and Journal → Settings. Everything pauses off-screen and in background tabs; phones get fewer stars and a lower pixel ratio.

Inner pages use `StateOrb`, the same orb at small size, whose movement follows real product states only: idle, gather (shuffling), pulse (an AI request is actually running; a cyan ring, cyan being reserved for AI), settle (a result arrived), quiet (reading).

**Licence note:** the orb's fragment shader is "Ether" by nimitz (Shadertoy MsjSW3), CC BY-NC-SA 3.0. It is used with attribution for the non-commercial hackathon demo and must be replaced or licensed before any paid version of MOONA. Changes to `src/components/cosmos/shaders.ts` stay under that licence; nothing else in the project is affected.

## Data and privacy

Readings, conversations, notes, check-ins, settings and birth details live only in this browser (`localStorage`). There is no account and no analytics. What reaches our server: the city name in the birthplace search, and — only for AI features — what each request needs (listed exactly on the About page). Birth date, time and place are never sent; the chart and Talk send computed placements only. The server passes AI requests to the provider and keeps no content, only call counts and cost for the cap. Deleting a reading or conversation also deletes the notes and check-ins that came from it; removing birth details removes everything derived from them.

## Astrology engine

- Positions: [astronomy-engine](https://github.com/cosinekitty/astronomy) (MIT), in the browser (`src/lib/astro/ephemeris.ts`), checked against Swiss Ephemeris fixtures (planets and angles < 0.02°, Placidus cusps < 0.05°). Swiss Ephemeris is only the test oracle (AGPL), not a dependency.
- Houses: Placidus and Whole Sign (`src/lib/astro/houses.ts`); Placidus falls back to Whole Sign near the poles, with a notice.
- Birth time → UTC with the browser's IANA history (`src/lib/astro/birth.ts`): repeated (fall-back) times ask which one; skipped times are flagged.
- Today's sky (`src/lib/astro/sky.ts`): events assigned to the user's local day; the daily horoscope uses the day's midpoint as a fixed reference moment.
- Places: GeoNames cities5000 (CC BY 4.0) in `data/places.json`, searched by `/api/places`.

## Sources and licences

| What | Source | Licence |
| --- | --- | --- |
| Card faces | 1909 Rider–Waite–Smith (Pamela Colman Smith), Wikimedia Commons; every card in `content/credits.json` | Public domain |
| Card back, MOONA mark, zodiac wheel, planet icons | Made for MOONA | Project's own |
| Interface, starfield, orb, whispers, Moon badge | MOONA team's Figma Make prototype ([KimChen001/Moona](https://github.com/KimChen001/Moona)) | Project's own |
| Orb shader "Ether" | nimitz, [shadertoy.com/view/MsjSW3](https://www.shadertoy.com/view/MsjSW3) | CC BY-NC-SA 3.0 (non-commercial demo; replace before paid use) |
| Animation, icons, styling | motion, lucide-react, Tailwind CSS | MIT, ISC, MIT |
| Zodiac line icons, astrolabe rings, Big Three glyphs | MOONA Figma design ("Graphite Night") | Project's own |
| Planet positions | astronomy-engine | MIT |
| Places | GeoNames | CC BY 4.0 |
| Fonts | Instrument Serif, Geist, Geist Mono, Cinzel, Pinyon Script via Fontsource | SIL OFL |
| QR codes | uqr | MIT |

No emoji are used anywhere: zodiac signs, planets and marks are SVG line icons (`tests/no-emoji.test.ts` guards this).

## Project layout

```
src/app/               routes (pages and /api)        src/components/       shell, cosmos (prototype visuals), chat, cards, chart wheel
src/lib/ai/            prompts, validation, claims, providers, budget
src/lib/astro/         ephemeris, houses, birth, chart, natal facts/themes, transits, horoscope, match
src/lib/chat/          message limits, sessions, context     src/lib/whispers/   post rules (wall not live)
src/lib/store.ts       device storage (patches, deletes, epoch)   src/lib/motion.ts   motion preference
src/lib/i18n/          en.ts (source of truth), zh.ts (type-checked against en)
content/               tarot cards, Learn entries, credits      public/            cards, design SVGs, brand, sw.js
eval/                  evaluation set                           tests/             vitest
```
