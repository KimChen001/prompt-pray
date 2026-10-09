# MOONA evaluation set

28 fixed cases that go through the app's own AI routes, used to pick the Demo Day provider (GPT vs Claude) on the same inputs. This is a task-specific check plus human blind review. It is not a benchmark.

| Group | Cases | What they cover |
|---|---|---|
| Natal | N1–N8 | birth time known/unknown, Moon changing sign that day, Sun at a sign boundary, Placidus vs Whole Sign, ambiguous DST time, polar Placidus fallback, southern hemisphere, EN/ZH pair |
| Tarot | T1–T8 | clear / vague / no question, A-or-B and relationship spreads, reversals, chart layer, shared notes contradicted by the question, a request for a certain prediction |
| Chat | C1–C6 | new information, the person correcting themselves, a request to draw another card, a medical-outcome question, a saved note contradicted by what they say now, Chinese |
| Horoscope | H1–H4 | Sun sign only, personal chart, a lunation day, Mercury retrograde |
| Crisis | X1–X2 | must be answered with support resources **before** any model call (no cost) |

The cases are kept separate from the examples inside the prompts. `eval/build.ts` fails if a case reuses a prompt example.

## Files

- `eval/build.ts` defines the cases and computes every input with the app's code (charts, sky, offline readings). Run `npm run eval:build` to regenerate `eval/requests.json`. A test fails if the JSON is stale or if any body would be rejected by the server.
- `scripts/eval-run.mjs` sends each case to a running server and records status, latency, estimated cost (from the server's budget ledger), the output text and heuristic flags.
- `scripts/eval-blind.mjs` turns two runs into a blind rating sheet (A/B shuffled per case, with a separate key) and scores exported ratings.

## Running a comparison (needs real API credit)

1. Put the first provider in `.env.local` (`AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, prices; see `.env.example`), then run `npm run build` and `npm start`.
2. `npm run eval:run -- --base http://localhost:3000 --access <AI_ACCESS_CODE if set>`. This dry run shows the provider, model, budget and number of calls (26).
3. Add `--yes` to spend. Expect about 26 calls. The server's caps (`AI_MAX_USD_*`, `AI_MAX_CALLS_PER_DAY`) still apply.
4. Stop the server, switch to the second provider, start again, and repeat steps 2–3. Restarting also resets the in-memory burst limit (40 requests/hour per client), which a full run nearly uses up.
5. `npm run eval:blind -- eval/results/<run A>.json eval/results/<run B>.json --out eval/results/blind`, then give graders only `blind.html`.
6. Graders rate each case (facts, specificity, answers the question, uncertainty, style, overall) and click "Export ratings".
7. `npm run eval:blind -- --score moona-blind-ratings.json eval/results/blind-key.json` prints per-model tallies next to the measured cost and latency.

## Reading the results

- `bad_output` means the server's validator rejected the model's reply (invented card, wrong placement, uncited evidence, unsafe text…). The user would have seen the offline/library text instead. A high rate is a quality signal, not a bug in the eval.
- ⚑ flags are regex heuristics (e.g. a certainty claim, ignoring what the person just said). They mark cases for a closer look, not for grading.
- Cost is the ledger estimate from configured prices, so check it against the provider dashboard. Latency is time to the full response (the routes don't stream).
- `*-key.json` files are git-ignored so the A/B key isn't shared with graders by accident.
- Mock runs (`scripts/mock-ai.mjs`) only prove the pipeline works. Never cite them as model quality.
