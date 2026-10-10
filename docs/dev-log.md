# MOONA dev log

Implementation and verification notes per step, for review. Plan: `outputs/MOONA产品与AI解读综合Review.md` and `outputs/MOONA产品讨论记录与留存策略.md` §10.4 (outside this repo). Demo: 2026-10-28. No real model calls are made in tests; AI paths are verified with mocked responses unless stated otherwise.

## Codex review fixes — 2026-10-09 07:24–07:35 America/New_York

Claude's last completion was at 05:37, the repository was clean, and its log had not changed when Codex took over these four reproduced defects. Scope recorded first in the shared night log; Windows remained locked, so no Claude UI message was sent. This section supersedes the earlier Step 1/2 claims where noted.

- Budget: reserve estimated maximum request cost before the network call, including UTF-8 input/schema/framing and maximum output; check spent + reserved money; settle known usage against the original UTC accounting day, with duplicate settlements blocked. Unknown-billing failures retain durable holds. Anthropic SDK automatic retries disabled so there is one attempt per reservation.
- Ledger: exclusive file locking across independent instances/workers; temporary file + atomic rename; only ENOENT initializes a ledger. Corrupt JSON, invalid fields and stale locks fail closed. Existing ledgers without reservations retain their spend. Status reports held money and returns unavailable on ledger failure. Provider-dashboard caps remain necessary for actual billing / distributed serverless storage; configured prices determine our estimate.
- Unknown-time aspects: sample both planets at 25 points across the local birth day, retain only matching aspects throughout the samples, rank with the widest sampled orb, and expose the approximate range in EN/ZH labels. A tight noon value no longer makes a Moon aspect certainly tight. `natal-facts@2`, `natal-text@2`.
- Themes: check all distinct life domains instead of any one; count a repeated domain only once per theme; expose `domainsRelaxed` for the existing minimum-target fallback. `natal-themes@2`. If reliable facts cannot supply three themes, show fewer with an explicit limitation rather than inventing more. Saved reports remain stored and readable; eval inputs rebuilt for the new rule versions.
- Cache upgrade: reconstruct the v1 fingerprint for unknown-time charts solely to recognize saved reports, not for interpretation or AI requests. The component retains the prior report and offers a manual update instead of automatically paying for another report. Independently compared reconstructed v1 facts against Git commit `5ab89e8` for all eight oracle charts; exact matches. A fixed legacy fingerprint is checked in the regression test.
- Verified: 451 tests in 17 files pass; TypeScript passes; production build passes. New regressions cover cross-instance money/call concurrency, remaining-money admission, restart/midnight settlement, corrupt/invalid ledger preservation, legacy ledger spend, unknown-billing holds, status availability, the Boston 1990-01-01 unknown-time Moon–Jupiter case, per-domain limits over generated charts, and saved v1 report recognition. No real model calls, purchases, push or deployment.

Next: Claude should read this entry and the shared `outputs/MOONA夜间修复交接-2026-10-09.md` before repeating the previous review work. Scope/accounts/visual decisions and real-provider eval remain pending.

## Step 1 — Natal fact layer + theme rules (2026-10-09)

**What**
- `src/lib/astro/natal-facts.ts` — `natalFacts(birth, chart)` builds typed facts with stable ids: `place.<planet>`, `angle.asc|mc`, `asp.<a>.<b>.<aspect>`, `angular.<planet>`, `ruler.asc`, `stellium.sign.<sign>|house.<n>`, `balance.element|modality.<value>.<dominant|absent>`. Every fact carries `timeIndependent`.
- All thresholds in `NATAL_RULES` (`natal-facts@1`): orbs 8/8/6/6/4 (conj/opp/sq/tri/sex) + 2° with a luminary; tight ≤ 3°; stellium ≥ 3 of Sun…Saturn; angular = houses 1/4/7/10 or within 5° of an angle; modern rulers; element/modality weights (Sun/Moon/Asc 3, personal 2, Jupiter/Saturn 1, outer planets 0); outer–outer aspects excluded as generational.
- Unknown birth time: no angles, houses, angular planets, ruler or house stelliums; degrees flagged `approximate`; a Sun/Moon that changes sign that day becomes `uncertainPlacement` (no sign used); Moon aspects kept only if they hold at both 00:00 and 23:59 local.
- `src/lib/astro/natal-themes.ts` — `selectThemes()` (`natal-themes@1`): core Big Three theme first, then candidates from tight/luminary aspects (must involve a personal planet), angular planets, chart ruler, stelliums, element/modality balance. Deterministic greedy pick of 3–5 with: each body in ≤ 2 themes, ≤ 2 themes per life domain (relaxed only to reach 3), ≤ 1 generational theme. `importance` is a documented design weight, not an accuracy score. Each theme has `id / title (EN/ZH) / evidenceIds / importance / domains / limitations`.
- `src/lib/astro/labels.ts` — bilingual aspect/element/modality/angle/house labels.

**Verified**
- `tests/natal.test.ts` (45 tests): aspect facts for all 8 Swiss Ephemeris reference charts equal an independent computation from the oracle longitudes under the same rules (pairs within 0.05° of an orb limit excluded); ids unique and stable; versions exposed.
- Theme rules hold for 246 generated charts (1990–1993, Boston/Sydney/Tromsø, known and unknown time): 3–5 themes, body/domain/generational caps, evidence ids exist, unknown-time themes cite only time-independent facts.
- Evidence relevance: placements cited only for the theme's own bodies; an angle is cited only when the planet is on it (caught and fixed a bug where "Moon in the 1st house" cited the Midheaven).
- Not verified: whether the chosen themes are the ones an astrologer would pick — that needs the eval set (Step 6).

## Step 2 — AI provider adaptation, persistent budget, honest source labels (2026-10-09)

**What**
- `src/lib/ai/capabilities.ts` — per provider/model capability table drives every request parameter. Claude 5.x (Opus 5.5, Sonnet 5.5, …): no `temperature`, `output_config.effort: "low"`, native `output_config.format` json_schema, server-side refusal fallback `fallbacks: "default"` (beta header `server-side-fallback-2026-07-01`; `AI_FALLBACKS=off` disables). Claude Haiku 4.5: `temperature` allowed, JSON by prompt + validation. OpenAI reasoning models (gpt-5*, o*): `max_completion_tokens`, `reasoning_effort: "low"`, strict `response_format.json_schema`, no `temperature`. OpenAI-compatible proxies (Parley): plain chat completions; Claude 5.x behind a proxy gets no `temperature`.
- Adapters: `providers/anthropic.ts` (official `@anthropic-ai/sdk`, beta Messages API; `stop_reason` `refusal` → `refused`, `max_tokens` → `bad_output`), `providers/openai.ts` (fetch; `message.refusal` → `refused`), `providers/openai-compatible.ts` (fetch).
- `src/lib/ai/config.ts` — `AI_PROVIDER` = `openai-compatible` (default, Parley) | `openai` | `anthropic`; `AI_MODEL` (OpenAI has no default: name the model you pay for; Anthropic defaults to `claude-opus-5-5`); caps `AI_MAX_CALLS_PER_DAY` (300), `AI_MAX_USD_PER_DAY` (5), `AI_MAX_USD_TOTAL` (25); prices per MTok from a table or `AI_PRICE_INPUT/OUTPUT_PER_MTOK` (unknown models use a high estimate so the cap errs safe).
- `src/lib/ai/budget.ts` — file-backed ledger (`.data/ai-usage.json`, git-ignored; `AI_USAGE_FILE` overrides). Each call reserves a slot first (serialized, so concurrent requests can't overshoot) and records its estimated cost after — including refused/truncated calls that were billed. On Vercel the file is in `/tmp` and reported `durable: false`: there it is NOT a hard cap; set a spend limit in the provider dashboard too.
- `src/lib/ai/provider.ts` — `generateJson(request, validate)` is the single path: config → budget → adapter → cost → parse → caller validation → `{ value, meta: { provider, model, generatedAt, costUsd } }`. Old `chatJson` removed.
- `GET /api/ai/status` — `available` + reason for everyone; provider, model and budget snapshot only for clients that pass the access code. Never returns keys.
- Horoscope: cached AI text now stores `meta`; the badge reads "AI · saved <time>" (model on hover) for cached text and "Live AI" only for text generated in this view. Cache key bumped to `moona.horoscope.v2` so old unlabeled entries are not shown.

**Verified**
- `tests/ai.test.ts` (21 tests, network mocked — no real model was called): exact request bodies/headers per provider (Opus 5.5 body has no `temperature`/`thinking`, has `fallbacks: "default"`, effort + json_schema; beta goes in the `anthropic-beta` header; Haiku 4.5 has `temperature`, no `output_config`; gpt-5-mini has `max_completion_tokens`, `reasoning_effort`, strict schema, no `temperature`/`max_tokens`); refusal/truncation mapping and billing; budget survives a "restart" (new instance, same file), enforces daily calls/USD and total USD, holds under 25 concurrent reservations with a cap of 10, and blocks without calling the provider; status endpoint hides details from locked clients.
- Browser: a seeded cache entry renders "AI · 已保存 10月9日 1:13" with the model in the tooltip and triggers no AI request.
- Not verified: any real provider response. Needs a key; the eval (Step 6) will do the first real calls.

## Step 3 — Tarot AI with layered reveal, follow-up chat, same-question choice (2026-10-09)

**What**
- Layer 1 (instant, offline): each card shows a one-line phrase — the first sentence of its reviewed meaning (`engine.ts` `phrase`, `firstSentence`). Offline reflection question per topic (`analysis.reflection`).
- Layer 2 (on demand): `/tarot/r/[id]` requests `POST /api/ai/tarot` as soon as the page opens, so the interpretation is usually ready when the user taps "Read the full interpretation". Saved on the reading per language (`reading.ai[locale]`) and never regenerated silently; "Try AI again" only after a failure. The offline reading is always one tap away ("Show the offline reading"). Badges: "Live AI" only for text generated in this view, "AI · saved <time>" (model on hover) otherwise, "Offline engine" when AI is unavailable.
- Layer 3: reflection question, then "Talk it through" (`TarotChat`, `POST /api/ai/chat`). The thread is saved on the reading. If the page already got a 503 (no AI here) the chat says so up front.
- Server rebuilds every card fact from ids (`src/lib/ai/tarot-prompt.ts`); client-sent names/meanings are never trusted. Output validation: every position exactly once, length limits, no undrawn card with a distinctive name (everyday-word names like Strength/力量 and, with the chart layer, The Sun/The Moon are excluded to avoid false alarms), orientation not flipped, crisis check. Chat replies get the same undrawn-card + crisis checks; crisis input never reaches the model (`{ code: "crisis" }` → support panel).
- Chart layer is opt-in per reading on the ask step ("Add my Big Three to the AI reading"); only Sun/Moon/Rising sign names are sent (`src/lib/astro/summary.ts`).
- Same question today (case/spacing/punctuation-insensitive, `src/lib/tarot/question.ts`): panel offers "Continue that reading" / "Add new information" (opens the reading's chat) / "Draw again" (new reading, the first is kept). Not a hard lock.
- `scripts/mock-ai.mjs` — DEV-ONLY fake OpenAI-compatible endpoint returning "[MOCK]"-marked text, to exercise UI AI paths without a key.

**Verified**
- `tests/tarot-ai.test.ts` (18): phrases for all 78 × 2 × 2 are complete sentences; request parsing rejects wrong counts/unknown/duplicate ids/oversized questions; prompt contains only drawn cards with positions/orientations; validation rejects missing/duplicate positions, invented cards ("The Tower", "宝剑七"), flipped orientation, unsafe text, and does not false-alarm on "strength"/"力量"; "The Moon" allowed only with the chart layer; chat parsing/validation; routes return validated output, 502 on invented cards, and never call the provider for crisis input. `tests/tarot.test.ts`: same-question normalization. Total 316 tests.
- Browser, AI unconfigured (dev server :3000): phrases render; AI request 503 → expand shows the offline reading with "Offline engine"; chat shows "needs AI" up front; same question with different case/spacing shows the three-choice panel; "Add new information" opens the original reading's chat.
- Browser, mock provider (separate `next start` on :3101 with `scripts/mock-ai.mjs`): interpretation generated before expanding (HTTP 200), "AI 实时" badge after expanding; chat reply quotes the user's message with "AI 实时"; after reload no AI request is made, both badges read "AI · 已保存 10月9日 4:22", offline reading still available; budget ledger shows 2 calls / $0.003 (matches 2 × (500 in + 200 out) at $1/$5 per MTok).
- Not verified: real model quality — the mock only proves the UI and contract wiring.

## Step 4 — Natal report: generation, claim checks, versioned saving (2026-10-09)

**What**
- `src/lib/astro/natal-text.ts` (`natal-text@1`) — bilingual fact labels (`factLabel`) and an offline "Library" paragraph per theme (`themeLibraryText`), written only from that theme's evidence facts.
- `src/lib/ai/natal-prompt.ts` (`natal-report@1`) + `POST /api/ai/natal` — the browser sends the facts the selected themes cite, plus every planet/angle placement as reference for claim checking; never birth date, time or place. The server rebuilds each fact's wording from the typed values (`factLabel`) and rejects malformed facts, unknown evidence ids, duplicate themes, and time-dependent facts sent with "time unknown".
- Validation of the model's JSON: every theme exactly once (order normalized), non-empty evidence ids that belong to that theme, length limits, crisis check, and key-field consistency (`inconsistentClaim`, EN + ZH patterns): "Planet in Sign" / "Sign Planet" must match the placement; an uncertain Sun/Moon may only be named together with its other possible sign; "Sign Rising" / "Ascendant in Sign" / "上升是…" must match the Ascendant; house numbers must match the planet's house; aspect claims ("Mars trines Jupiter", "火星与木星形成三分相") must be an actual aspect fact; no degrees in prose. Without a birth time: no Rising sign and no house may be named (saying they need a birth time is fine).
- `src/lib/astro/natal-report.ts` — version key = report type + chart fingerprint (FNV-1a over the fact list) + time known + house system (fixed when time is unknown) + facts/themes/text/prompt versions + language. Saved versions (`moona.natal.v1`, max 20) are self-contained: theme titles, frozen evidence labels, limitations, text, model and time.
- `NatalReport` on `/chart` replaces the "in development" panel. The first version for a chart + language is generated automatically, then shown as "AI · saved <time>". If the rules or prompt changed since then, the saved version stays and a notice offers "Write an updated version" (user-triggered only). The version list shows each saved version as "this chart" / "earlier rules" / "earlier birth details", with View and Delete; a deleted version is not regenerated silently. Library text is always available offline and is the fallback when AI is off or fails. Each theme has "Why this reading" (fact labels) and its limitations.
- Privacy: removing birth details (new button on `/me`) also removes saved natal reports; "Clear all" covers them; the export includes them. The `/me` and About privacy text now lists what each AI feature sends (the earlier text, "the only server call is the birthplace search", was out of date since the AI features shipped).

**Verified**
- `tests/natal-ai.test.ts` (76 tests, network mocked — no real model was called): for every Swiss-Ephemeris fixture chart, with and without birth time — the request body has no birth date/place/name, the prompt lists every theme; our own Library text passes validation in EN and ZH (the validator and the offline layer agree); a wrong sign for any placement (cited or not, both word orders) is rejected; foreign evidence ids are rejected. Rules: missing/duplicate themes, empty evidence; Rising right/wrong (EN/ZH), Rising and houses with unknown time; wrong house (EN/ZH); wrong or non-existent aspects (EN/ZH); uncertain Moon named alone vs. with both options; degrees; crisis text (EN/ZH); tampered requests. Versions: fingerprint stable for the same chart, changes with birth time and house system; language and prompt version separate keys; `sameChart` ignores only versions; house system irrelevant without birth time; saved versions freeze titles and evidence labels. Route: 200 with prompt version + metadata and no birth data in the upstream request; 502 `bad_output` when the model contradicts a placement; 400/503 without calling the provider. Total 392 tests; `next build` clean.
- Browser, mock provider (separate `next start` on :3101 with `scripts/mock-ai.mjs`, stopped afterwards): first visit → "Live AI" and one saved version; reload → "AI · saved", 0 natal requests; stored prompt version changed to `natal-report@0` → old version shown with the "rules have changed" notice and no request; clicking "Write an updated version" → 1 request, new version current, old one listed as "earlier rules"; viewing the old version and the Library text each show a "Back to current" notice; switching to 中文 → a separate zh version generated once; birth time removed → new chart version with the Rising/houses limitation, older ones listed as "earlier birth details"; deleting the current version → Library text, no regeneration, "Write an AI reading" offered; `/me` "Remove birth details" → birth and saved reports both gone. Budget ledger: 4 calls / $0.006 = exactly the four generations above.
- Not verified: real model quality and how often a real model trips the claim checker (false rejections fall back to Library text). Step 6's eval with purchased credit will measure this.

## Step 5 — User-confirmed memory and in-site check-ins (2026-10-09)

**What**
- `src/lib/memory.ts` — `MemoryNote` (`origin: "typed" | "suggested"`, `quote`, `readingId`, `confirmedAt`): a note exists only because the person saved it. `CheckIn` (step, local due date, open/done/dropped, optional outcome). Pure helpers: calendar-date math, due list, quote check (`isQuoteOf`, NFKC/case/space-insensitive), duplicate check, RFC 5545 `.ics` (all-day event, escaping, 75-octet UTF-8-safe folding).
- Sharing is opt-in per reading: the ask step shows "Share my saved notes with the AI for this reading (n)", off by default, listing exactly the notes that will be sent (max 8). The reading stores note ids only; the reading page shows "Saved notes shared with the AI for this reading (n)" with the list and "Stop sharing". Deleting or editing a note changes what later requests send.
- Server: `notes` in tarot/chat requests are parsed (≤ 8 × ≤ 200 chars) and put in the prompt as "confirmed earlier; may be out of date"; the model is told to trust what the person says now and may ask once whether a note still holds. Crisis text in a shared note is handled like a crisis question (support panel, no model call).
- Chat suggestions: the chat schema adds `remember` (0–1 items `{text, quote}`); the prompt allows only concrete facts the person stated, never inferred feelings, traits or motives. The server keeps a suggestion only if its quote is really in the person's messages of this request (not the model's words, not a saved note), the text is short, safe, mentions no undrawn card and isn't already saved; otherwise it is dropped without failing the reply. In the UI it is a card under the reply ("Remember this for later readings?" + "From what you said: …") with Save / Edit / No thanks; nothing is stored until Save.
- Check-ins: at the end of a reading, "Plan a check-in" (step prefilled from the reading's action; 3 days / 1 week / 2 weeks / date). Home shows "Your check-ins" when one is due ("How did it go?" → Done / Didn't happen, then "Continue the reading"); `/me` lists all. Copy states MOONA can't send notifications; "Add to calendar (.ics)" generates the file on the device. No push or email is promised.
- Deletion: deleting a reading (now with a confirm that says so) deletes the notes and check-ins that came from it; deleting a note removes it from readings that shared it; "Clear all" and the export cover notes and check-ins. `/me` "What MOONA remembers" lists notes with their origin and date, with edit, delete and add. Privacy text (`/me`, About) updated for notes and check-ins.
- `scripts/mock-ai.mjs` chat replies now include a `remember` suggestion quoting the user's message.

**Verified**
- `tests/memory.test.ts` (15): date math across month/year/leap/DST days; date validation; due/upcoming lists; `.ics` CRLF, DTSTART/DTEND/DTSTAMP, escaping of `; , \ newline`, folding ≤ 75 octets with Chinese text intact; quote checks (case, full-width, too short, Chinese); notes parsing limits and prompt wording; crisis in a shared note (tarot and chat); suggestion validation keeps a grounded one and drops model-worded inferences, duplicates of saved notes, over-long, undrawn-card and crisis text, and quotes taken from saved notes; replies without `remember` still validate; chat route returns the suggestion and forwards shared notes; tarot route never calls the model for a crisis note; store cascade (delete note → unshared; delete reading → its notes/check-ins gone, others kept), edit keeps order, export and clear. Total 407 tests; `next build` clean.
- Browser, mock provider (separate `next start` on :3101 + `scripts/mock-ai.mjs`, both stopped afterwards; :3000 untouched): added a typed note on `/me`; on the ask step the share box appears with the note listed; full draw → reading stores the note id; switching to 中文 sent a tarot request whose body carried the note; chat request carried it too; the reply showed a pending suggestion (not yet in the note store); Edit + Save stored it as `suggested` with quote and reading id, and the turn shows "Saved". Planned a check-in (prefilled, 3 days → Oct 12); with its date moved to today, Home showed "Due today" + "1 upcoming"; Done with an outcome → "Continue the reading" (`?talk=1`). On `/me`, deleting the reading asked for confirmation and removed its suggested note and check-in while keeping the typed note and the unrelated check-in. Ledger: 3 calls / $0.0045 = tarot EN + tarot ZH + one chat.
- Not verified: the `.ics` download click in a browser (the file content is unit-tested; the download itself was not triggered), and how real models use notes or how often their suggestions pass the quote check — Step 6's eval with purchased credit covers that.

## Step 6 — Evaluation set and comparison tooling (2026-10-09)

**What**
- `eval/build.ts` → `eval/requests.json` (`moona-eval@1`, 28 cases): natal N1–N8 (time known/unknown, Moon changing sign that day, Sun at 0° Aries, Placidus vs Whole Sign, ambiguous DST time, polar fallback, southern hemisphere, EN/ZH pair), tarot T1–T8 (clear/vague/no question, A-or-B, relationship, reversals, chart layer, shared notes contradicted by the question, a request for a certain prediction), chat C1–C6 (new information, self-correction, "draw another card", medical-outcome question, a contradicted saved note, Chinese), horoscope H1–H4 (sign only, personal chart, lunation day, Mercury retrograde), crisis X1–X2. Inputs are computed with the app's own code; the build fails if a case reuses a prompt example.
- `scripts/eval-run.mjs` — runs the cases through the real routes of a running server (one provider per run): dry run by default (prints provider, model, budget, 26 model calls), `--yes` to spend; records status/code, latency, cost (budget-ledger delta), output text and heuristic ⚑ flags; stops on rate limit or budget cap.
- `scripts/eval-blind.mjs` — pairs two runs into a self-contained blind sheet (A/B shuffled per case with a seeded RNG, key in a separate git-ignored file; ratings autosave locally and export as JSON) and `--score` tallies wins/ties/losses per criterion next to measured cost and latency.
- `eval/README.md` — how to run the GPT vs Claude comparison once credit is bought. `tsx` added as a dev dependency (to build cases from the TypeScript sources); `npm run eval:build|eval:run|eval:blind`.

**Verified**
- `tests/eval.test.ts` (4): `requests.json` equals a fresh build; 20–30 cases, every route in both languages; every body passes the server's parsers and exactly the crisis cases are caught before a model call; N4 really has an uncertain Moon, N3's facts differ from N1's, N7 uses the fallback, no natal body contains birth date/place. Total 411 tests.
- Mock pipeline (separate `next start` on :3101 with `AI_ACCESS_CODE`, `scripts/mock-ai.mjs`; stopped afterwards, :3000 untouched): without the code → "locked"; dry run sends nothing; run A: 26/26 model calls ok, X1/X2 "crisis" at $0, $0.039 total (26 × $0.0015); run B on a restarted server with 3× prices: $0.117 (exactly 3×). Flags T7/C2/C4 fired on the canned mock text as expected; the T8/C4 heuristics were then tightened to ignore negated phrasing (checked on sample sentences). Blind sheet: 26 cases, ratings autosave and restore after reload, no horizontal scroll at 375 px; scoring synthetic ratings un-blinds correctly.
- Not done (needs the user's API credit): the real GPT vs Claude runs and the human blind ratings. No real model has been called in any step so far.

## Learn — signs, planets, houses, aspects, 78 cards, spreads (2026-10-09; scheduled Oct 13)

**What**
- Content (`content/learn/*.json`, EN + ZH): 12 signs (dates, summary, strengths, growth edge), 10 planets (glyph, pace, summary), 12 houses, 5 aspects (glyph, angle), 4 spreads (how to use). Cards reuse `content/tarot` (78 × upright/reversed: keywords, meaning, love, work, growth, advice, card description). Keywords, planet functions, house themes, rulerships and orbs come from the same tables the chart and natal report use, so Learn and the readings can't disagree.
- `src/lib/learn` — one index of 121 entries with stable ids (`/learn/<type>/<slug>`); search in both languages at once: names (exact > prefix > contains), aliases (rising/上升 → 1st house, MC/天顶, 水逆 → Mercury), then keywords/body text; type filter; Latin queries need 2+ characters, a single Chinese character is allowed. Plan v0.2 named MiniSearch; with ~120 entries a scored substring match is simpler and handles Chinese without a word segmenter, so no dependency was added.
- `/learn` (search, type chips, browse; cards grouped by arcana/suit) and `/learn/[type]/[slug]` (sign: element, modality, modern + traditional ruler, same-element signs; planet: function, pace, signs it rules; house: theme, natural sign, angular/succedent/cadent; aspect: angle and the orb MOONA actually uses; card: image, description, both sides, prev/next, image credit; spread: positions, how to use, "Use this spread"). "In your chart" is computed in the browser from saved birth details (which of your planets are in a sign / where a planet is / which planets are in a house; houses need a birth time).
- Favorites on every detail page (`moona.favorites.v1`), listed under "Saved from Learn" on `/me`, included in export and "Clear all".
- Cross-links: `/chart` planets, Big Three signs and house numbers; card names on the reading page; today's card; Home's Learn tile is now live. `content-check` now also verifies Learn content (every id once, every field in both languages, no English left in Chinese fields).

**Verified**
- `tests/learn.test.ts` (6): counts 12/10/12/5/78/4 with unique ids and non-empty EN/ZH titles and subtitles; content ids equal the app's sign/planet/house/aspect/spread ids; rulerships come from the chart-ruler table (each sign has one modern ruler); search finds the Moon for "moon", "Moon", "月亮" and full-width "ｍｏｏｎ" (plan acceptance), ranks names first, resolves aliases (rising/上升, midheaven, 水逆, 高塔, 抉择), filters by type, ignores 1-letter Latin queries and allows one Chinese character. `npm run check:content` passes (78 cards + 43 Learn entries). Total 417 tests; `next build` clean.
- Browser (separate `next start` on :3101, stopped afterwards; :3000 untouched): browse shows all six sections; "moon" and "月亮" both return the Moon first and The Moon card second; "xyzzy" shows the no-results state with suggestions; all six detail types render, an unknown slug shows "That page doesn't exist"; with test birth details, "In your chart" matched `/chart` (Moon in Cancer, 2nd house; Sun, Mercury, Mars, Saturn in the 11th); Save → reload → still saved → listed on `/me`; Chinese page renders (Chinese list separator and full-width parentheses fixed after this check); `/chart` has 25 links into Learn; no horizontal scroll.

## Match — same-device version (2026-10-09; scheduled Oct 15)

**What**
- `src/lib/astro/match.ts` (`match-rules@1`): Emotional = Moon–Moon and Sun–Moon both ways; Communication = Mercury–Mercury and Mercury–Sun both ways; Attraction = Venus–Mars both ways and Venus–Venus; Big picture = Sun–Sun, plus Rising–Rising and Sun–Rising both ways only when **both** people have a birth time and place. Each pair is an aspect (birth-chart orbs, +2° with a luminary) or, when there's certainly no aspect, an element relation (same / compatible / different). Tones: trine/sextile and same or compatible elements = Easy flow; conjunction = Spark; square/opposition and different elements = Growth edge, except in Attraction, where Venus–Mars tension reads as Spark. A dimension's label is the tone with the most weight (ties → Spark; nothing certain → "Not enough info"). Vibe score = weighted average of the certain factors' traditional values (shown under "How the score works"), with "For fun… not a prediction of relationship success."
- Missing details: without a time, each body is sampled across the local birth day; without a place, the time is ignored and the window covers every time zone (UTC+14 to UTC−12). A sign or aspect is used only if it holds for every sample; otherwise the factor is "uncertain", shown as such and left out of labels and score.
- `/match`: "You" from saved birth details (or typed just for this match), the other person's nickname, date (required), time and place (optional; a time is used only with a place); consent note; saved matches. `/match/r/[id]`: score, three dimension cards with label, template text and a "Why" list of every factor (aspect glyph linking to Learn, signs and elements, or "can't be certain"), Big picture, notes on what was left out, delete. Results are saved as snapshots (stable on reload). Matches are also listed on `/me`; removing your birth details removes matches computed from them; export and "Clear all" cover them. Home's Match tile is live. Remote invites are not built (they need a backend and are an open decision).
- `PlacePicker` extracted from the birth form (same behavior) and reused here.

**Verified**
- `tests/match.test.ts` (11) on the Swiss-Ephemeris fixture births with full, no-time and no-place combinations: every "aspect" and "element" claim re-checked by an independent dense sampling (61 instants per window) of both birth windows; certain signs really don't change in the window; score within the factor-value range or null; Rising factors only when both have time + place, with the right notes. This test caught a bug in the first version: a Rising–Sun cross factor was used when only one person had a Rising. Fixed. Also: self-match gives exact conjunctions, label rules, Venus–Mars tone rule, input validation. Store test: removing birth details deletes matches computed from them and keeps typed ones. Total 429 tests; `next build` clean.
- Browser (separate `next start` on :3101, stopped afterwards; :3000 untouched): "You" summary from saved details; place search for the other person; result "You & Sam", 64, Easy flow / Easy flow / Growth edge with every factor listed, Moon factors "can't be certain" (no time), Rising note; identical after reload with all "Why" lists open; typed own details with time but no place → time ignored (hint shown), all notes shown, the other person's Sun uncertain on the solstice (2000-06-21), Emotional "Not enough info"; Delete returns to `/match`; Chinese result renders. The "Why" label briefly reused the horoscope's "Why: today's sky"; replaced with a Match label after this check.

## Share images (2026-10-09)

**What**
- Server share links (`/s/[id]`, revocable snapshots, plan §3.9) need a database, so they wait for the Supabase account. Share **images** are generated entirely in the browser and are done now.
- `src/lib/share/content.ts` decides what an image may contain (pure, tested). A reading shows spread, date, cards with orientation and their one-line phrases, plus the action. Today's card shows the card and its first sentence. The chart shows only the Big Three sign names (never birth date, time or place). A match shows the score, its label and the three dimension labels with the for-fun disclaimer. The question and the other person's nickname appear only when the person ticks a box (both off by default).
- `src/lib/share/render.ts` draws a 1080×1350 PNG on a canvas (site fonts, public-domain card art, reversed cards rotated, CJK-aware wrapping, footer kept clear of the wordmark). Placeholder look until the team's UI arrives.
- `ShareImage` on the reading page, Today, `/chart` (Big Three) and match results: preview, "Download PNG", and "Share…" through the system share sheet where the browser supports sharing files. Nothing is uploaded.

**Verified**
- `tests/share.test.ts` (4): question absent unless opted in; Big Three image text contains no birth date, time, place or coordinates, and an unknown time shows "?" for Rising; match image has no nickname by default (title "You & Them") and no birth data, shows score and three labels with the disclaimer; daily-card content. Total 433 tests; `next build` clean.
- Browser (separate `next start` on :3101; a local-only receiver on 127.0.0.1:3998 saved the generated PNGs for inspection; both stopped afterwards, :3000 untouched): each image is 1080×1350 (`naturalWidth/Height`). Viewed the reading image with the question opted in (reversed Three of Swords rotated, long phrase truncated with an ellipsis), the Chinese Big Three image, the match image and the daily-card image. Fixed after viewing: rows-only images left a large empty area, so they are now vertically centred; the match footer overlapped the wordmark; the score now has a "Vibe score" label.

## PWA: installable, offline drawing and reading (2026-10-09)

**What**
- `src/app/manifest.ts` (standalone, dark theme, 192/512 and maskable icons). Icons from `scripts/make-icons.mjs` (sharp): the brand logo masked to its round wheel, since the source image has a light-grey square background. `appleWebApp` metadata and favicon updated.
- `public/sw.js`, registered only in production builds as `/sw.js?v=<build id>` (`NEXT_PUBLIC_BUILD_ID` from `next.config.ts`, so each deployment installs fresh caches and old ones are deleted). Strategies: `/api/*`, RSC payloads and the worker itself always go to the network; `/_next/static`, card art, brand and icons are cache-first; pages are network-first with fallback to the last good copy, then a route shell, then `/offline`. At install it caches 9 main pages, 3 route shells, every build file those pages reference (found in their HTML, plus fonts referenced by the CSS) and all 78 card images.
- Route shells (`src/lib/shell.ts`): one cached copy each of `/tarot/r/_shell`, `/match/r/_shell` and `/learn/_shell/_shell` stands in for any uncached reading, match or Learn URL; those pages read the real id from the address bar after hydration. This lets a reading drawn offline open its result page.
- `/offline` page (EN/ZH) saying what still works offline. Security headers on all routes (`nosniff`, `SAMEORIGIN`, `strict-origin-when-cross-origin`) and no-cache headers for `/sw.js`, following the Next 16 PWA guide in `node_modules/next/dist/docs`. No push notifications: per the review, install and notification capability are accepted separately, and notifications are not built.

**Verified**
- `tests/sw.test.ts` (5): runs `public/sw.js` in a sandbox and checks routing (`/api/*`, `?_rsc`, `/sw.js` → network; build files and art → cache-first; navigations → page), shells only for reading/match/Learn detail URLs, 78 unique precached card ids that all exist on disk, and asset discovery from HTML (including escaped chunk ids in the RSC payload) and CSS (relative and absolute `url()`, data URLs ignored). Total 438 tests; `next build` clean.
- The Claude desktop in-app browser refuses to register service workers ("unknown error when fetching the script", although the page could fetch `/sw.js` fine), so the real test ran in a headless Microsoft Edge with a throwaway profile driven over the DevTools protocol (profile deleted afterwards). Online: the worker activated with `?v=<build id>` and cached 147 files (81 art, 66 build files including 39 fonts) and 12 pages. Then the `:3101` server was **stopped**: `/tarot/new` loaded from cache; a full draw opened a new `/tarot/r/<id>` through the shell with the card and its phrase; the full reading fell back to "Offline engine" with "AI is unavailable right now"; a never-visited `/learn/card/major-00` rendered The Fool with its images; `/whispers` showed the offline page; `fetch('/api/ai/status')` failed (never cached).
- First attempt failed and was fixed: pages loaded offline but crashed with `ChunkLoadError`, because the precached pages' JS chunks had never been downloaded. Asset discovery at install was added for that, and the build-id versioning so later deployments stay consistent.
- Side notes: the fresh Edge profile auto-installed a Tampermonkey extension (it opened a welcome tab and wrote an `AMP_unsent_*` localStorage key). That's machine-level browser configuration, not MOONA: the build and source contain no analytics code (searched `.next/static`, `src`, `public`). Editing `next.config.ts` made the user's `next dev` restart its worker process (new PID under the same `next dev` parent); the dev server kept running.
- Brand note for the team: the logo's zodiac wheel has errors (Libra, Scorpio and Capricorn appear twice; Aries, Sagittarius and Pisces are missing; the order is off). It's used unchanged; it should be fixed when the UI design lands.

## Visual pass 1: Graphite Night design system (2026-10-09)

Decision (user, 2026-10-09): web only; the WeChat mini-program is obsolete. Visuals come from the team's Figma file "MOONA — Graphite Night · Design System · Birth Details"; pages without a design only inherit the foundations. Implementation notes for the team: `outputs/MOONA设计稿实现记录-2026-10-09.md`.

**What**
- Foundations (`globals.css`): the Figma tokens (BG #0B0C10, PANEL #14161C, INPUT #1B1E26, FG / SECONDARY / META, SILVER, GOLD for the Sun only, CYAN for the Live AI badge only, 1px white-10% borders), Cormorant Garamond / Inter / JetBrains Mono roles, 16px panels, pill buttons, mono field labels, Library / Live AI badges. Starfield and glows removed ("no gradients").
- Header (`AppShell`): wordmark + text nav (Home · Natal Chart · Tarot · Guidance → /today · Journal → /me) with Learn / Match / Whispers / About under "More"; phone menu button; footer tagline. Old sidebar, tab bar and `icons.tsx` removed.
- `/chart/edit` (Birth Details), new `/chart/reveal` (Big Three Reveal), `/chart` (Birth Chart) rebuilt to the frames. Assets from the design in `public/design/` (astrolabe rings, houses circle, original MOONA Sun/Moon/Rising glyphs, 12 zodiac vectors), used unmodified.
- `ChartWheel`: data-driven wheel in the design's style. Standard convention (AC at 9 o'clock, counter-clockwise zodiac, house 1 below the AC, MC on top); planets at their real longitudes with overlap spreading, aspect lines from the natal fact layer; no houses or angles without a birth time. The Figma wheel is a fixed illustration and doesn't follow this convention.
- Big Three taglines (`content/astro/taglines.json`, 12 signs × Sun/Moon/Rising, EN/ZH); interpretation cards for the Big Three (Library) + "Chart synthesis" (AI overview, same version as the full report via the new `useNatalReport` hook).

**Verified**
- Typecheck, 451 tests, `next build` clean. Screenshots from a headless Edge with a throwaway profile against `next start` on :3101 (both stopped): Birth Details, Big Three and Birth Chart at 1440 and 390 match the Figma layouts; Aug 14 1999 07:30 Boston computes Leo Sun 21°14′, Virgo Moon 28°58′, Virgo Rising 9°38′ (the Figma numbers are illustrative); unknown-time Chinese state shows "X或Y"/"未解锁"; home, tarot and today inherit the foundations; phone menu lists all sections; no horizontal scroll at 390px. Wheel labels were too small on phones and were enlarged.
- Not done: designs for Home, Tarot, Guidance, Journal, Learn, Match, Whispers and share images (waiting for the team).

## No emoji, ever (2026-10-09)

Rule from the user: MOONA's assets never use emoji — above all for zodiac signs and chart symbols.

**What**
- Removed every emoji-capable character from shipped code and content: the zodiac symbols (U+2648–U+2653) are gone from the sign data; Venus/Mars (U+2640/U+2642) gone from the planet content, wheel and table; the Match "↗" link is now "→"; share images no longer prefix Big Three rows with symbols.
- Signs always use the Figma zodiac SVG vectors; planets use ten MOONA line icons in the same style (`public/design/planets/*.svg`, 48×48, silver 1.7 stroke; placeholders until the design team supplies planets). `src/components/AstroIcon.tsx` (`ZodiacIcon`, `PlanetIcon`, `EntryIcon`) is the only way these symbols are drawn. Aspect symbols (☌ ⚹ □ △ ☍) stay as text; none of them is emoji-capable.
- `tests/no-emoji.test.ts` fails on any non-ASCII character with the Unicode Emoji property in `src/`, `content/`, `public/design/`, `eval/` and `scripts/`, and checks the detector itself (catches the zodiac signs, Venus, Mars, the arrow and colour emoji; allows the plain arrows, ✦ ✧, ☉ ☽, aspect symbols, ° and CJK).

**Verified**
- 453 tests pass; `next build` clean. Headless Edge screenshots (throwaway profile, stopped afterwards): the chart wheel and planet table, the Learn sign and planet lists and the horoscope sign buttons all show the SVG icons; the rendered `/today` text contains 0 emoji-capable characters.

## Round 2: nebula home, Talk, tarot flow, review fixes, every page (2026-10-09)

Brief: `outputs/MOONA完整实施交接指令.md` (with the design supplement, the overall repo review and the visual review). Commits `d96a138` → `03d961b`.

**Visual system and motion**
- Tokens recoloured to the confirmed moonlight palette (bg #0E0D16, surface #171620, text #F0EDE7, silver #BFC5D2, mist #A394C7, cyan #5EE6D0 for real AI states only); every text/surface pair checked (text-3 ≥ 5.1:1).
- `components/nebula/`: one WebGL program pair on one canvas — a soft violet–blue band around a dark eye with silver filaments (written for MOONA after the Ether / Flowing Waves references; the reference repo's Ether shader is CC BY-NC-SA and was not used), plus an optional star-dust field orbiting in tilted rings that parts around the pointer, bursts on a tap and flows into the orb while shuffling. Static CSS orb first; lite mode on phones (3 octaves, 90 motes, 0.75× resolution, ~30 fps, slow-device guard); pauses off-screen / in the background; releases its context on unmount; reduced motion = one still frame; Motion: Auto / Reduced / Off.
- Shell: phone tab bar (Home · Today · Tarot · Chart · Journal), full menu sheet with every module and the motion setting, safe areas, `viewport-fit=cover`, `interactive-widget=resizes-content`, tab bar hidden while typing, compact chrome on landscape phones, x-overflow clipped at the shell.

**Features**
- Home: nebula hero, Draw a card / Explore your chart / Talk with MOONA, greeting built only from saved records (visit time, due check-in, last reading or conversation), every module, desktop QR (site root only; `NEXT_PUBLIC_SITE_URL`, honest test/local labels).
- Tarot: one nebula through the ritual (gather while shuffling), phone snap row / desktop fan, one-line message as each card turns, reading page with layered reveal, "Why this reading" (inputs by kind and how the text was written), continue-with-these-cards chat with undo, unified share sheet (image + text, question off by default), original card back.
- Talk (`/talk`, `/talk/c/[id]`, `/api/ai/talk`): free conversations; context only if ticked (chart facts — never birth data; today's date + zone, sky recomputed on the server; chosen notes); SAID / CALCULATED / reflection kept apart in the prompt; server keeps only basis ids it provided and rejects contradicting claims; undo send; delete; offline-safe.
- Memory: notes record their source (reading or conversation) and can be edited, paused or deleted; deleting a conversation deletes its notes.
- Today, Journal, Learn, Match, About, Whispers (private writing; shared wall marked not live with its open decisions), offline and 404 pages redesigned; chart gets the house-cusp list; Aries icon centred, Moon glyph stray line removed; generated zodiac wheel (each sign once, in order) and new icons replace the old logo.

**Review fixes** (overall review §1–§7)
1. Shared claim checker (`lib/ai/claims.ts`) for natal, horoscope and Talk: copulas ("Your Sun is in …", "sits in", "which is in", "sign is"), ingress verbs, Chinese 是/为/处于/坐落 and sign names without 座; negations not flagged. Horoscope output is checked against server-verified facts.
2. One message contract (`lib/chat/limits.ts`): trimmed on whole messages, always starting with the person; merged retries; separate user/reply limits so accepted replies always fit back.
3. Unknown birth time in the horoscope: hourly natal samples (aspects only if they hold all day), solar houses labelled, both Sun signs on change days with no house facts.
4. Deletes clear storage, memory copies (kept only when storage is blocked) and derived data (matches, horoscopes, chart context in conversations).
5. Field-level patches on the latest copy; replies appended only if their message is still newest; data epoch drops results after clear / birth changes; per-language AI merges; stale horoscope / natal responses dropped.
6. Horoscope cache key = rules/prompt versions + local date + zone + fingerprint of every input (date, time, DST choice, zone, place, house system) + language; fixed reference moment; saved text shown with its fact sentences.
7. Text share uses the same preview and "include my question" default (off) as the image.

**Verified**
- 518 tests (store deletes and late writes, 12-round chats through both routes in EN/ZH, Talk context and claims, unknown-time horoscope, DST cache keys, server fact checks, share defaults, greeting, QR, Whispers rules), typecheck, content check, `next build` clean.
- Production build + mock AI (1.5 s delay) in a headless Edge (throwaway profile): 11 Talk rounds (22 messages, all Live AI with basis chips), undo and delete mid-request (nothing resurrected; the conversation's note deleted with it), language switch mid-request on a reading (both languages kept, thread intact), reading deleted mid-request (stays deleted), horoscope Live AI → AI · saved → new request after a house-system change, reduced motion / Off / WebGL unavailable (static orb, buttons work), offline via the service worker (pages, shells, Talk failing honestly), slow network (400 ms, 50 KB/s, no cache: first paint 1.18 s, Draw a card usable at 1.2 s, nebula after the 7.9 s load), no console errors on 18 pages, no horizontal overflow at 320/390/430/768/landscape/1280/1440 in EN and ZH. Found and fixed during this: a hydration mismatch on /talk, a 1,298px-wide card row on phones, landscape and 320px layouts.
- Screenshots: `outputs/screenshots-2026-10-09-round2/`.
- **Not verified:** real models (no authorised credit used; Parley key not entered), real iPhone / Android devices, frame rate and battery on phones, QR scanning on a deployed HTTPS site, soft-keyboard behaviour on real devices.

## Figma Make prototype shell and Ask home (2026-10-09)

The team asked to use its own Figma Make prototype ([KimChen001/Moona](https://github.com/KimChen001/Moona)) as the site's look and motion, ported into this app (not a rebuild).

**What**
- Ported from `Moona/src/app/App.tsx` into `src/components/cosmos/`: Cosmos (warp starfield, pointer aura, whisper glow), Orb (Ether shader, aura, warm tint, shrink-and-rise when a conversation starts), ShaderCanvas, Whispers (EN as in the prototype; ZH added, phrase by phrase), MoonBadge (now fed by the real ephemeris for the local day). `AppShell` is the prototype's Rail / TabBar / sheet: Ask · Cards · Sky · Journal + More (chart, learn, match, whispers, about), QR dialog, language toggle.
- Ask home (`src/app/page.tsx`): the prototype layout with real behaviour. Typed messages start a real Talk session (saved, continued in Talk, late replies can't overwrite, 503 says plainly that AI isn't connected and offers a card, crisis language shows support). "Draw a card for today" = the real daily card; "How is the Moon tonight?" = calculated phase, illumination, sign and next phase; "What should I let go of?" = a real one-card reading saved to the Journal.
- Not ported: the prototype's sign-in (it signed in a sample user). Accounts don't exist, so the account entry explains that everything is saved on this device and offers Journal and data export.
- `StateOrb` replaces the round-2 WebGL nebula on inner pages (ritual, today, readings, Talk) with the same Ether orb at small size, keeping the real-state mapping (gather / pulse with a cyan ring / settle / quiet). `src/components/nebula/` and the old home's WelcomeBack are removed.
- Styling: Tailwind v4.1.12 (theme + utilities, no preflight) in `src/app/styles.css`, with `globals.css` in its own layer below the utilities. Prototype tokens: background #07060c, text #ece8f4, gold #c9a96e for the active line, glass panels over the starfield. Fonts: Instrument Serif, Geist, Geist Mono, Cinzel, Pinyon Script (Fontsource, OFL). Share images use the same fonts and colours.
- Licence: the Ether fragment shader (nimitz, CC BY-NC-SA 3.0) is attributed in the file header, About and README; usable for the non-commercial demo, to be replaced or licensed before paid use.

**Bugs found and fixed while porting**
- Tailwind's spacing utilities (`gap-12` = 48px) silently overrode the site's own `gap-12` (12px), loosening every inner page. Converted all 121 legacy uses to Tailwind's scale (`gap-3` etc.) and dropped the old classes; a scan of every legacy className confirms no other Tailwind name collides. Big Three ring images renamed from `ring-0/1/2` (Tailwind ring utilities) to `astro-ring-*`.
- Bare buttons showed the browser's grey default once preflight was skipped: added a zero-specificity button reset.
- Basis chips squeezed their "Calculated" label into a vertical stack on phones: the label no longer shrinks.
- Step headings that receive focus for screen readers no longer draw a focus box.

**Verified**
- 518 tests pass; TypeScript passes; production build passes.
- Headless Edge (GPU) against `next start` with the mock AI: Ask on desktop 1440×900 and phone 390×844 (EN and ZH), the three prompts, a typed message answered by the mock model with "Continue in Talk", the tarot ritual (orb gathers while shuffling, then idle), Talk on a phone (pulse ring while the request runs, then quiet), Today, Tarot, Journal, Chart; motion Reduced (still frames) and Off (no canvas, static orb). No horizontal overflow on any page at either size. Screenshots: `outputs/screenshots-2026-10-09-prototype/`.
- No real model calls, no real-device testing yet.

## P1: birth chart and today's sky checked as separate sources (2026-10-09, evening)

From Codex's 15:51 review (`outputs/MOONA巡检与原型Review-2026-10-09-1551.md`): Talk and the horoscope merged natal and today's-sky signs into one allowed set, so "Your natal Moon is in <today's sign>" and "Today's Moon is in <the natal sign>" passed, in English and Chinese, and today's sky could settle an uncertain natal sign. Reproduction: `work/review-claims-1551.ts` (now prints `contradictoryReplyAccepted: false` for all four cases).

**What changed**
- `src/lib/ai/claims.ts` (`claims@2`): facts are kept per source (`natal`, `sky`) and every claim is checked against the source it is about. Source comes from words at the claim (before it wins over after it), then a list continuing the previous claim ("your Sun in Leo and Moon in Aries", "你的太阳…，月亮…"), then the nearest source word earlier in the sentence, then the only source with facts, the product default (horoscope: sky) or both. A claim worded about a source with no facts counts as invented. Someone else's placement ("his Sun", "对方的月亮") and generic statements ("In general, a Cancer Moon tends to…") are not checked. Uncertain natal signs must be named with their other option right beside them, or in contrasting/conditional pairs within one sentence; hedges ("may be", "可能") don't count, and today's sky never settles them. Houses carry their basis (birth chart vs solar) and bind to the nearest planet; Ascendant/Midheaven are birth-chart only; bodies MOONA has no facts for (Chiron, Nodes, Lilith…) are rejected. Coverage added for markdown emphasis, Chinese numerals/full-width digits/traditional characters and alternative sign names, 刑/拱/冲/六合, 上升天秤, 太阳摩羯-style shorthand, subjectless clauses, "is conjunct/forms a square with", appositives, comparisons ("like today's Moon"), "are both in", degrees written 度/º/˚. Under 1 ms per reply.
- Talk (`talk@2`): prompt lists BIRTH CHART and TODAY'S SKY separately and asks for source wording; chart chips are labelled "Birth chart:" / "本命："; basis always includes the fact behind each checked claim, from the right source; on an ingress day the earlier sign comes from the real position (correct for retrograde planets); no degrees, no sky houses/aspects.
- Horoscope (`horoscope@3`, `horoscope-rules@3`): the person's signs are natal, today's sky is sky (unlabelled claims read as sky); houses keep their natal/solar basis; Ascendant transits checked; both signs on an ingress day; the template's "why" list and the AI request now include every fact the template text uses.
- Tarot and its follow-up chat (`tarot@2`): the opted-in Sun/Moon/Rising is accepted only as sign names and every sign claim is checked against it (birth-chart only).
- Natal report: `natal-report@2` (same prompt; recorded because the checker changed). Saved reports stay and are offered for a manual update as before.
- Versions and money: horoscope texts are now cached without versions in the key and store the versions they passed. A text from older versions is kept, re-checked locally against today's facts with the current rules, shown if it still holds, and rewritten only when the person taps "Write it again with the current rules". A rewritten key never pays again, a failed rewrite keeps the older valid text, an unknown server version is never assumed current, and a paid answer is cached even if the language changed meanwhile. Old saves (`${versions}|${key}` keys) are still found. Talk, tarot, chat and natal responses record `meta.versions`.

**Verification**
- 596 tests pass (58 new in `tests/claims-sources.test.ts`, covering EN/ZH, chart+today, chart only, today only, unknown birth time, the same planet in different signs, today's sign equal to an uncertain natal option, two sources in one sentence, basis ids, versions and the old cache format). TypeScript passes. Eval set rebuilt (`eval/requests.json`: horoscope cases now carry the template's Moon-house fact).
- Adversarial review workflow: five attack lenses (EN false accepts, ZH false accepts, false rejects, unknown time/houses/aspects, integration) wrote ~50 probe scripts against the real code; each lens's findings were re-run by an independent skeptic. ~90 confirmed findings; all realistic ones fixed and re-run. The 13 probe lines still flagged are contrived forms (pronouns "it sits in", "Libran in tone", degrees without °), by-design rejections (the person's sign stated when no chart was shared), verifier-refuted cases, or now-correct acceptances.
- Not done here: production build of this exact tree (Codex is verifying on :3104 and `.next` must not be rebuilt concurrently; a separate worktree build follows), real-model calls (none made).

**Next**: shared persistent budget ledger and paid-pack preparation (design workflow done; implementation spec next).

## Budget S0 + S1: per-visitor limits, correct prices and billing classes (2026-10-09, night)

Spec: `docs/ai-ledger-spec.md` (synthesised by a design workflow: three independent designs, two judges, one spec; the correctness-first design won, built in the minimal design's order).

**S0 (commit 4265231)**: signed visitor cookie (`src/proxy.ts`, `src/lib/visitor.ts`) replaces the per-IP burst limit; serverless hosts fail closed ("ledger") without a shared ledger; deployments without SESSION_SECRET are "misconfigured".

**S1 (this commit)**
- `src/lib/ai/pricing.ts`: integer nano-USD per token per category (input, output incl. thinking, cache write 5m = 1.25x, 1h = 2x, cache read per model); component-wise ceiling for unknown served models; fallback targets (Opus 5.5 → Opus 5 / 4.8, Sonnet 5.5 → Sonnet 5 …); cost per attempt at the model that ran it; bound = primary + each allowed fallback hop at full output cap.
- `src/lib/ai/usage.ts`: Anthropic `usage.iterations` → one attempt each (refused attempt + fallback rescue); a served model other than the requested one without iterations is incomplete (bound charged); OpenAI/proxy usage normalised; missing usage incomplete.
- Adapters return per-attempt usage and classify errors: 429/529 and 4xx-before-work = billed "none" (settled at 0, retry-after kept); timeouts/5xx/connection = "unknown" (hold kept); refusal/truncation/bad JSON = "known".
- Every purpose has an output cap (thinking included): tarot 3000, chat 1200, talk 1200, natal 5000, horoscope 1500 (`AI_MAX_OUTPUT_*`). Tarot previously reserved and requested the 8000-token default. **Calibrate on test credit**: a cap that is too low truncates (and a truncated reply is still billed).
- `AI_PROVIDER=fake` (`providers/fake.ts`): in-process stand-in with "[MOCK]" replies that pass every validator, simulated usage, scripted failures (`FAKE_AI_FAILURES`), allowed only off deployments or on a preview with `AI_ALLOW_FAKE_ON_DEPLOY=1`. Its output is never "Live AI".

**Verification**: 622 tests pass (19 new in `tests/pricing.test.ts`); TypeScript passes. No real model call, no spend.

**Next (S2)**: shared SQL ledger (Postgres functions under one global lock, PGlite for offline tests), plans and audit invariants.

## Budget S2: the shared SQL ledger, plans and audit (2026-10-09, late night)

Built to `docs/ai-ledger-spec.md` §3.3, §4 and §7. Nothing calls it yet: routes switch to it in S3.

**Ledger**
- `src/lib/ledger/sql/*.sql`, applied by `migrate.ts` with checksums:
  - 001 tables (immutable once applied).
  - 002 PL/pgSQL functions, re-applied whenever they change. Every money or entitlement change is one function call that takes the single gate-row lock first.
  - 003 database roles (real Postgres only).
  - 900 a test clock, applied only by tests.
- `sql-ledger.ts`: one `select moona.<fn>($1::jsonb)` per method, from an allowlist. Connection-level failures become `LedgerUnavailable`; anything else is a bug and is rethrown. Timestamps come back as UTC ISO.
- `drivers.ts`: two backends.
  - `pg` 8.23.1 (Supabase transaction pooler, pool cached across warm starts).
  - PGlite 0.5.8 (real Postgres in WASM, dev dependency, `serverExternalPackages`).
- `file-ledger.ts`: the old JSON budget behind the same contract, for local single-process development (free mode only).
- `factory.ts` (`MOONA_LEDGER`):
  - `auto` uses Postgres when `DATABASE_URL` is set, and otherwise refuses on serverless.
  - It falls back to the file ledger locally.
  - `pglite` and `memory` migrate and sync themselves.
  - Postgres never does. A plan-hash mismatch is reported to operators only.
- `plans.ts`:
  - The `dev` and `event-2026-10-28` plans from §7.2: $100 = AI $50 + hosting $20 + reserve $30.
  - Windows: testing $10, Demo Day $35 (with a $15/h slice), after $5. The pack pool is $0, so sales stay closed.
  - Environment overrides and a stable hash.
  - Pack allocation is computed from the worst-case request bounds (`ai/worst-case.ts`): 5 x (reading + 2 follow-ups).
  - `validatePlan`.
- `levels.ts`: ok / notice / warn / critical / exhausted, for the status route.

**Two deviations from the spec SQL (both in `sync_plan`)**
- **Overlap check:** it now only compares windows that can still admit. Switching dev → event mid-testing closed `win:dev` "at now" and then refused, because the closed window overlapped testing in the past.
- **Slice cap:** a live slice's cap is never lowered below what it already spent and holds. Before, lowering the hourly slice mid-hour broke the audit's cap invariant.

**Tests (offline, PGlite)**: `ledger.smoke`, `ledger.free`, `ledger.reaper`, `ledger.plan`, `ledger.concurrency`, `ledger.fuzz` (free). `audit()` is empty after every step.
- **Fuzz:** the default run is 3 seeds x 400 steps, with three profiles (tight quotas, provider storms, tight caps). It checks that every denial kind is actually reached. `LEDGER_FUZZ_FULL=1` runs 21 x 2000.
- **Concurrency:** PGlite serialises statements, so this proves per-call atomicity, not row locking under contention. That needs `ledger.pg` against a real database (S3+, `TEST_DATABASE_URL`).

**Verification**: 661 tests pass; TypeScript passes. No database account, no real model call, no payment.

**Next (S3)**:
- `meter.ts` (reserve → provider → complete/fail with retries) and the five AI routes plus status on the ledger.
- Client request ids for replay.
- Visitor ids become UUIDs minted via `mint_visitor` (the ledger requires `v:<uuid>`; the Phase 0 cookie id is 22 base64url characters).
- The quota and "simulated" labels in the UI.

## Horoscope rewrite pays once (Codex review 20:51, P2) (2026-10-09, late night)

- **The bug:** after the person asked to rewrite an older saved horoscope, the request stayed "asked for" on that key. Two ways it paid again without a new click:
  - Coming back to the sign, if the server answered on other versions (deploy skew).
  - Coming back after a failed rewrite.
- **The fix:** a rewrite is now a one-shot token, used up when its request starts. The failure notice's retry asks for a new rewrite. A request already running for a key is joined, not sent twice, when the person switches away and back.
- **Tests:** `tests/horoscope-panel.test.ts` renders the real component (happy-dom, mocked fetch). It runs Codex's sequence: older cache 0 calls → rewrite Leo 1 → Aries 2 → back to Leo still 2. It also covers a failed rewrite, fast switching while a request runs, and strict mode. The old component fails 3 of the 4.
- **Dev dependency:** `happy-dom` 20.14.6 (jsdom 30 needs Node 24.15+; this machine has 24.11).

## S2 review fixes (2026-10-09, late night)

An independent review agent tried to break the S2 ledger with throwaway tests. It found no P1: no cap overrun, double charge, stuck hold, double grant or audit corruption. The fixes are in commit a09c0d5, with regressions in `tests/ledger.review.test.ts`.

**P2**
- An exhausted older pack could block a funded newer one and close sales for everyone. A pack that can still pay is now used first.
- A follow-up without a reading hash skipped the reading check. A missing hash now counts as a mismatch.

**P3**
- Bound billing never charges less than the bound.
- A late text is never stored again after a purge.
- Slice ids include their length, so hourly and daily slices never share a row.
- A used window can't move into the future.
- U+0000 is dropped before jsonb.
- Only errors without a code are classified by their message, and TLS failures count as the ledger being down.
- `sslmode` in the URL no longer overrides the TLS settings.
- A production migrate puts the real clock back.
- Checksums ignore line endings.
- Roles are re-granted after a function change.
- Dates hash by their value.
- `validatePlan` names the database's own ranges.
- There is no in-memory ledger on a deployment.

**Left as is**
- The rate-limit window is tumbling, not sliding; only unbilled 429s are counted there.
- A late payment re-acquires its holds without the pack slack.

## Budget S3: every AI route on the ledger (2026-10-09, late night)

- **`ai/meter.ts`:**
  - It reserves the request's bound, calls the provider exactly once, then completes or fails by billing class.
  - Completion is retried through a ledger hiccup. If the ledger stays down, the reading is still returned and the reaper charges the bound.
  - Nothing is called without "reserved".
- **`ai/handler.ts`:** the shared order of every route: access → parse → preflight (crisis and bad facts reserve nothing) → ledger → visitor → burst limit (file ledger only) → meter → response.
  - The five routes are now short specs; each exports `maxDuration = 60`.
  - A Sun-sign-only horoscope is shared between visitors; anything with a Moon or Rising sign is not.
- **Status (`http.ts` `meterResponse`):** the codes of spec §8.2. For example 202 still running, 409 make a new id, 422 id reused, 429 quota, 503 budget/ledger/busy/cooldown/paused.
- **Status route:** shows budget levels (notice/warn/critical/exhausted) and details only to clients with access. It never shows costs or keys.
- **Identity:**
  - `identity/keys.ts` derives separate HKDF keys from SESSION_SECRET.
  - `identity/visitor.ts` holds a UUID in a signed `moona_vid` cookie. It is minted lazily through the ledger's mint caps (per window and per hashed /24 or /48 network).
  - The Phase 0 proxy and its 22-character ids are removed.
- **Browser (`ai/client.ts` `requestAi`):** every request carries a request id, saved with its record before sending: the reading per language, or the chat turn. 202, busy and cooldown are retried with the same id; a failed id gets exactly one new id.
  - Every call site is switched over: reading page, tarot follow-ups, Talk, home Talk, horoscope and birth-chart report.
  - The quota, budget, paused and busy lines come from spec §10.1, in both languages, with a "low tonight" line.
  - Fake-provider texts show "Simulated reading — no AI call", never "Live AI".
- **Privacy copy (EN/ZH):** it now says what the server keeps: visitor counts, keyed request fingerprints (never text), and each AI reply for 2 hours (a shared Sun-sign horoscope for a day).
- **Tests:** `identity`, `meter`, `routes.ai`, `client`, `event-sim`.
  - **Demo Day simulation:** 200 visitors behind one address in three hourly waves on the real event plan. The fake provider adds 2% rate limits and 1% timeouts; visitors double-click, reload and clear cookies; the ledger goes down for 60 s.
  - **Result:** all 1000 demanded readings are served, every pool stays within its cap, no visitor goes over quota, nothing is left in flight, and the audit is empty.
  - **At maximum cost:** with 450 visitors, the $15 hourly slice refuses requests before the 2500 call cap.
- **Verification:** 700 tests pass; TypeScript passes. Not covered: no real model or database was used, and the fallback-attempt share of the simulation is not modelled.

**Next (S4):** paid packs, still offline:
- Order, lot and webhook flows through fake payments.
- A Stripe adapter with offline signature checks.
- Account and operator identity.
- The `/api/packs*`, webhook and `/api/ops/*` routes.

## Budget S4: reading packs, offline (2026-10-10, early morning)

Nothing here takes real money. Payments are `off` by default. `fake` has no provider and works only locally (or on a rehearsal preview that opts in). `test` and `live` need keys the team sets in the host's environment. `live` additionally needs every precondition in spec §7.3.

- **`payments/config.ts`:** the payment mode and every failed precondition. Problems are shown to operators only; the public sees "not enabled". A live key in test mode, a missing confirm, the fake account provider, a non-Postgres ledger, missing terms/refund/support, uncleared commercial assets or a non-https site each make it `misconfigured`.
- **`payments/stripe.ts`:**
  - Stripe Checkout with idempotency keys `order:<id>`. Metadata is only the order id.
  - Webhooks are verified with the SDK's `constructEvent` on the raw body. Stripe 23.0.0 is pinned and makes no network call for signatures.
  - Each event is normalised to paid / unpaid / expired / async_failed / refund_full / refund_partial / dispute / ignored.
- **`payments/fake.ts`:** a local checkout. `deliver()` builds Stripe-shaped events, signs them like Stripe and sends them through the real webhook handler.
- **`payments/service.ts`:**
  - `startCheckout`: the ledger holds the pack's AI allocation and the fee estimate before any redirect, and the url is released only after the session is attached.
  - `handleWebhook`: a bad signature returns 400 with nothing written; a livemode mismatch returns 400; ledger down returns 503 so the provider redelivers.
  - `syncOrder`: the return page's verified retrieve, so a late webhook can't strand a payment.
  - `reconcile`: reaps, settles finished orders, purges, and audits; any violation trips the breaker.
  - `salesState`: the first failing reason, in the documented order.
  - `purchaseAction`: a real purchase only live and open; tests only for operators on a deployment.
- **Identity:**
  - `identity/ops.ts`: operator devices via OPS_TOKEN, 12 h, failed attempts throttled. Operators skip free quotas, never money caps.
  - `identity/auth.ts`: `none` (default: nobody can buy) or `fake` (a test account tied to this browser, local or operators only). The real provider is the team's decision.
- **Routes:**
  - `/api/packs`
  - `/api/packs/checkout`
  - `/api/packs/orders/[id]`
  - `/api/stripe/webhook`
  - `/api/ops/session`
  - `/api/ops/reconcile` (GET for the scheduler with CRON_SECRET, POST for operators)
  - `/api/ops/fake-pay`
- **Paid AI:** tarot `use: "paid"` and chat `paidReadingId`, only when asked for. Without an account the answer is 401; with no credits, 402. A free quota denial reports the account's credits.
- **Tests:** `ledger.paid` (with isolation), `orders` (with recovery), `webhook` (official SDK, offline), `payments.config`, `packs.flow` (the whole purchase through the routes) and `ops`.
  - The fuzz gains a packs walk: orders, duplicate and out-of-order events, refunds, disputes, revoke-mode, paid readings, follow-ups and free traffic, with the audit checked after every step.

**Verification:** 738 tests pass; TypeScript passes. The full packs fuzz ran 12 seeds × 1500 steps (88 s) with the audit empty after every step. No real payment provider, account, model or database was used.

**Next (S5):**
- The packs panel on Me, in the prototype's style.
- The explicit "use 1 pack reading" choice on the reading page, and follow-up counts.
- The fake checkout page.
- Scripts: `ledger-admin`, `budget-plan`.
- Privacy copy for orders and credits.

## Budget S5, part 1: packs panel, fake checkout, scripts (2026-10-10, early morning)

- **Packs panel (`components/packs/PacksPanel.tsx`) on Me:**
  - **Off by default:** while payments are off (the default) it renders nothing and the Packs tab is hidden, so the approved page is unchanged. This is a deliberate deviation from spec §10.4, which shows a "not enabled" banner.
  - **Fake and test modes:** the first line says so.
  - **Content:** the terms are shown before any purchase, along with a gold hairline credit meter, paid readings with their follow-ups, and orders with plain state labels.
  - **Buy button:** it appears only when the server's `action` allows it. The checkout key is kept in sessionStorage for resume.
  - **Back from checkout:** `?order=` polls the server until the provider has confirmed.
- **Fake checkout (`/packs/fake-checkout/[id]`):** a 404 unless payments are fake (operators only on a deployment). Pay / Decline / Expire / Deliver twice send signed events through the real webhook path.
- **Copy:** the `m.packs.*` copy in both languages comes from spec §10.4 via `payments/copy.ts`. The About page says what packs keep; card details go only to the payment provider.
- **Scripts:**
  - `npm run budget:plan` prints bounds, the pack allocation, packs that fit, the windows' typical-call capacity and validatePlan, offline. At Sonnet 5.5 prices, Demo Day's $35 is about 2160 typical calls.
  - `npm run ledger -- …` runs migrate / sync-plan (records AI_PRIOR_SPEND_USD once) / snapshot / audit / reap / reconcile / record-spend / set-flag / revoke-mode-test. It uses DATABASE_OWNER_URL or MOONA_PGLITE_DIR and never prints keys.
- **Fix:** on Windows, the legacy file budget's lock can fail with EPERM/EACCES/EBUSY while another worker releases it; it now waits and retries. This was the intermittent `ai.test` failure under the full parallel run.
- **Verification:**
  - Tests: 743 tests pass (four full runs in a row); TypeScript passes.
  - Build: the worktree production build passes.
  - On 3106 in fake mode, the whole browser flow works: simulated purchase → signed event "granted" → back on Me "5 readings added.", the meter at 5/5, the order marked Simulation. The server was stopped after.
  - On 3000 with payments off, Me shows no Packs tab or panel.
