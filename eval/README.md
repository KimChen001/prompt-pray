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
- `scripts/eval-run.mjs` (logic in `scripts/eval-lib.mjs`) sends each case to a running server the way the browser does. It records the outcome, the number of HTTP attempts, latency, cost where it can be attributed, the output text and heuristic flags.
- `scripts/eval-blind.mjs` turns two runs into a blind rating sheet (A/B shuffled per case, with a separate key) and scores exported ratings.

## How a run talks to the server

- **One visitor.** Before any AI request, the runner asks `/api/ai/visitor` and keeps the server's cookies. A new visitor must come back as known; if the cookie doesn't stick, it stops before sending anything. It never makes a new visitor to get around a quota.
- **One request id per case.** Every attempt for a case uses the same id, so the shared ledger replays or joins it instead of starting another model call.
  - "Still running" (202) and "busy" are waited on with the same id, up to `--max-wait` seconds (default 120); then the case is recorded as `pending`.
  - A lost response is retried once with the same id, only when the server uses the SQL ledger, which replays. The legacy file ledger has no replay, so there a lost response is recorded as `lost` and never re-sent.
  - A 409 (an earlier attempt with this id failed) is recorded as `failed`, not retried with a new id.
- **Limits stay on.**
  - A free-quota refusal stops the rest of that route's cases, recorded as `not_run`.
  - A global refusal (budget, paused, ledger, locked, not configured, visitor cap) stops the run.
  - Results are saved after every case.
- **After the run**, one completed case is sent again with its id (SQL ledger only). The server must replay it with no new model call, and the result file records this.
- **Outcomes:**
  - `completed`: answered by a model call for this case.
  - `replayed`: answered from an earlier or shared result, with no new call.
  - `handled`: answered before any model call (crisis).
  - `failed`, `refused`, `lost`, `pending`, `error`, `not_run`.
  - The number of HTTP attempts is reported separately from model calls. Model calls are inferred from the server's answers, and measured from the ledger where possible.

## Cost

- **Who sees spending.** The public `/api/ai/status` never shows spending. Only an operator device sees it, and the runner signs one in only when an operator token is configured: `MOONA_EVAL_OPS_TOKEN`, or `OPS_TOKEN`, from the environment. The token and cookies are never printed or saved.
- **Without an operator device**, every cost is `null` ("unknown"), never 0.
- **With one**, a case's cost is the ledger's change around that case. It is attributed only when nothing else was in flight, nothing was held, and the ledger's call count moved by exactly what the case did.
  - Otherwise the cost is `null` with the reason: other traffic, or a lost or delayed response that can't be checked.
  - The run total is given only when every sent case was attributed. If anyone else uses the server during a run, expect unknowns rather than someone else's cost.
- **Ledger shapes.** Both are read: the shared SQL ledger (AI pool and window) and the legacy file ledger (total and today).
- **What the number means.** Cost is the ledger's estimate from the configured prices, not the provider's invoice. Check it against the provider dashboard.
- **Venue code.** If the server has one, give it as `AI_ACCESS_CODE` (or `MOONA_EVAL_ACCESS`) in the environment. `--access CODE` also works but shows the code in your shell history.

## Running a comparison (needs real API credit; not done yet)

1. **Start the server** with the first provider: `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` and prices in `.env.local` (see `.env.example`), then `npm run build` and `npm start`.
   - Use the SQL ledger so lost responses replay, quotas hold across restarts and cost can be attributed. Locally that is `MOONA_LEDGER=pglite`, or `DATABASE_URL` for Postgres.
   - With the default `dev` plan, every visitor gets 100 free requests per route. On the event plan, a visitor gets only one or two, so either use the `dev` plan or run from an operator device with `--operator-requests`. That applies the server's operator rule (`AI_OPERATOR_QUOTA_EXEMPT`); the global caps still apply.
2. **Dry run.** `npm run eval:run -- --base http://localhost:3000` reads only the status: no visitor, no AI request, no quota. It shows the provider, the model, the number of model cases (26), whether this is an operator device, and the ledger's spending if it is.
3. **Spend.** Add `--yes`. Expect 26 model calls and 2 crisis cases with none. Every server cap still applies, and the run stops cleanly at any of them.
4. **Second provider.** Stop the server, switch providers, start it again and repeat steps 2–3.
5. **Blind sheet.** `npm run eval:blind -- eval/results/<run A>.json eval/results/<run B>.json --out eval/results/blind`, then give graders only `blind.html`.
6. **Rating.** Graders rate each case (facts, specificity, answers the question, uncertainty, style, overall) and click "Export ratings".
7. **Scores.** `npm run eval:blind -- --score moona-blind-ratings.json eval/results/blind-key.json` prints per-model tallies next to the measured cost (or "cost unknown") and latency.

## Reading the results

- `bad_output` means the server's validator rejected the model's reply (invented card, wrong placement, uncited evidence, unsafe text…). The user would have seen the offline/library text instead. A high rate is a quality signal, not a bug in the eval.
- ⚑ flags are regex heuristics (e.g. a certainty claim, ignoring what the person just said). They mark cases for a closer look, not for grading.
- Latency is time to the full response, including any waits (the routes don't stream).
- `*-key.json` files are git-ignored so the A/B key isn't shared with graders by accident.
- Runs with `AI_PROVIDER=fake` (simulated replies) only prove the pipeline works: identity, replay, quotas, cost reading and the files. Never cite them as model quality. The GPT vs Claude comparison on these 28 cases waits until API credit is available.
