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
