# MOONA dev log

Implementation and verification notes per step, for review. Plan: `outputs/MOONA产品与AI解读综合Review.md` and `outputs/MOONA产品讨论记录与留存策略.md` §10.4 (outside this repo). Demo: 2026-10-28. No real model calls are made in tests; AI paths are verified with mocked responses unless stated otherwise.

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
