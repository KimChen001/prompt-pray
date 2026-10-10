# MOONA: shared AI ledger, visitor quotas and paid reading packs. Implementation spec

This spec was synthesised on 2026-10-09. No repository file was modified. Nothing here has been deployed, charged, purchased or sent to a real model. Everything below runs offline: fake provider, fake payments, PGlite.

## 0. Ground rules and sources

**What this spec combines**
- **Base design:** D1, the winner. Every money or entitlement change is one PL/pgSQL `jsonb -> jsonb` function. Each function first takes the same global row lock, and `moona.audit()` recomputes every counter from the detail rows.
- **Additions:** the ideas both judges asked to graft in (§1.2).
- **Fixes:** every listed flaw is fixed (§1.3).

**Sources read**
- `outputs/MOONA100美元预算方案.md`, which sets 8 constraints.
- `outputs/MOONA付费解读包实施补充.md`.
- `src/lib/ai/*`: budget, provider, config, guard, capabilities, types, http and the providers.
- The five AI routes and the status route.
- `tests/ai.test.ts` and `tests/no-emoji.test.ts`.
- The Next 16.4 docs, `src/lib/store.ts`, `src/lib/tarot/types.ts`, `src/app/tarot/r/[id]/page.tsx`, `TarotChat.tsx` and `scripts/mock-ai.mjs`.

**Rules from the project**
- Extend the existing code. Do not rebuild it.
- `budget.ts` and its tests stay.
- No emoji anywhere: `tests/no-emoji.test.ts` scans `src`, `scripts` and `content`. Icons are SVG only (lucide-react or `icons.tsx`).
- Never label simulated output as "Live AI". Never show a real-money button unless payments are live.

**Next 16.4 rules, checked in `node_modules/next/dist/docs`**
- Edge runtime is deprecated, so routes export no `runtime` and stay on Node.
- `export const maxDuration = N` is supported.
- GET route handlers are dynamic by default. Still send `Cache-Control: no-store`.
- Read cookies with `req.cookies.get`. Set them with `res.cookies.set` on `NextResponse`. `cookies()` from `next/headers` is async and is not needed here.
- Dynamic params are a Promise. Type them explicitly as `{ params: Promise<{ id: string }> }`, so `tsc --noEmit` does not depend on the `RouteContext` typegen.
- The webhook raw body comes from `await req.text()`.
- `pg` is on Next's auto-external list.
- Never use `after()` for money settlement.

**`src/lib/store.ts` already exists** (the browser storage layer). New payment code therefore lives in `src/lib/payments/`, and the routes live under `/api/packs/*`.

## 1. What changes and why

### 1.1 Defects in the current code that this fixes

| # | Where | Defect | Fix |
|---|---|---|---|
| 1 | `guard.ts` `clientKey` | 40 AI calls per hour per `x-forwarded-for`, per instance. On shared school Wi-Fi, one room shares those 40. | Identity is a signed visitor cookie. With the SQL ledger the authoritative limits live in the database (quotas, in-flight per subject, failed cap). The in-memory limiter is keyed by subject and used only with the local file ledger. |
| 2 | `budget.ts` `usageFilePath` | On Vercel the ledger is `/tmp` per instance (`durable:false`) yet keeps serving requests. | On any serverless host without `DATABASE_URL`, AI returns 503 `ledger` before any provider call. |
| 3 | `anthropic.ts` | Prices `cache_creation` and `cache_read` tokens at 1x input. | 5-minute writes at 1.25x, 1-hour writes at 2x, reads at the per-model rate (Opus 5.5 and Sonnet 5.5: $0.20/MTok). |
| 4 | `anthropic.ts` | Ignores `usage.iterations`, so refused attempts and fallback attempts go uncounted. | Each attempt is priced at the model that served it. |
| 5 | `provider.ts` | Prices with `cfg.prices`, the requested model, even when a fallback served the reply. Opus 5.5 falls back to Opus 5 or Opus 4.8 at $5/$25. | Per-attempt pricing, as in #4. |
| 6 | `requestCostBound` | Excludes the fallback hop. Tarot sends no `maxOutputTokens`, so the bound uses the 8000-token default for Claude 5.x. | Bound sums over 1 + fallback hops. Every purpose has an output cap. |
| 7 | All adapters | A definite HTTP 4xx/429/529 leaves a hold that never settles, and so does missing usage. | Every error is classified by billing: `none` (charge 0, calls refunded), `known`, `unknown` (charge the bound), or `bound` (missing usage, charge the bound). |

### 1.2 Grafts applied

- **D2 Phase 0 ships first,** with no database: limiter keyed by visitor cookie, fail closed on serverless, and regression tests.
- **D2 static split.** A pack pool is carved out of the $50, and `sync_plan` checks it: Σ(window caps, or spent+held for past windows) + packs cap ≤ ai cap, and ai + hosting + reserve ≤ cash. The pack pool defaults to $0, so sales stay closed. This sits next to D1's dynamic `ai.spent+ai.held` check, so two independent guards protect pack money.
- **D2 Stripe settings.** `expires_at` = order `created_at + 31 min`, stored on the order so idempotent retries send identical parameters. `payment_intent_data.metadata.order_id` is set.
- **D2/D3 key reuse.** The idempotency path compares `input_hash` and `mode`; a mismatch returns 422 `key_reused`.
- **D2 misconfiguration and prior spend.** Payments have a `misconfigured` state that is distinct from `unconfigured`. `AI_PRIOR_SPEND_USD` is recorded once as an idempotent entry.
- **D2/D3 test purchases** are allowed only from operator devices on any deployed host.
- **D3 licence gate.** Live mode requires `COMMERCIAL_ASSETS_CLEARED=1`, because the CC BY-NC-SA Ether shader is still in `src/components/cosmos/shaders.ts`. The licence fix stays scoped to that one component.
- **D3 pacing.**
  - An hourly sub-cap ("slice") inside the demo window.
  - A per-subject in-flight cap (default 2).
  - A 429/529 circuit: 5 rate-limit replies in 60 s trigger a cooldown.
  - Calls are refunded when billing is `none`.
  - `AI_INFLIGHT_MAX` is sized from the purchased key's rate-limit tier.
- **D3 offline rehearsal.** An in-process fake provider, plus an event simulation (vitest) and an optional HTTP rehearsal script. Both fail on any `audit()` violation.
- **D3 request ids** are made with `crypto.getRandomValues`, because `randomUUID` is unavailable on insecure LAN origins.
- **D3 horoscope cache.** The shared cache applies only to Sun-sign-only subjects (`subject.mode === "sign"`, no moon, no rising).
- **D2 + D1 database exposure.** The `moona` schema is outside the Supabase Data API. RLS is enabled with no policies, and the `moona_app` role has EXECUTE only. This matters because `.env.example` already plans `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **D3 output caps.** Per-purpose output caps (thinking included) live in config.

### 1.3 Flaws fixed (D1 base)

| Flaw | Fix |
|---|---|
| Idempotency ignored the input hash | `reserve` returns a `key_reused` denial when the hash or mode differs. |
| `attemptsPerUnit=1` could strand an owed credit | A paid reserve takes `take = least(bound, lot free)` and holds the shortfall `extra` on the pack pool's slack (`PACK_SLACK_USD`, which `create_order` must leave free). If neither covers it, the result is `paid_capacity`: the credit is kept, sales close, and the lot is flagged as unservable for refund review. |
| Test-clock GUC usable by any role | Production `_clock()` ignores input. A test-only migration `900_test_clock.sql` replaces it, and only `migrate({testClock:true})` applies it. |
| Stripe `expires_at` borderline and drifting | Stored as `checkout_expires_at = created + 1860 s`. Retries reuse it. |
| A cached free result was returned for a paid reading, with no follow-ups | Cache and in-flight dedupe are free-mode only. Paid requests always generate and create their `paid_readings` row. |
| Mint cap could be drained globally | DB-backed per-net-bucket mint ceiling, 400 per /24 (or IPv6 /48) per 10 minutes, sized for 200 people behind one NAT. Plus a generous window mint cap (demo 3000). |
| Packs ate demo headroom | Static split above. |
| `search_path` without `pg_temp` | Every function has `set search_path = pg_catalog, pg_temp`, and every name is schema-qualified. |
| Price ceiling was not a component-wise max | `PRICE_CEILING` is the component-wise max over the table and the legacy 15/60 estimate. An iteration with no model is priced at the requested model (primary) or the max of the fallback targets (fallback). |
| A partial refund revoked the whole lot | `charge.refunded` with `amount_refunded < amount` becomes `refund_partial`: a review note, no revoke. |
| Overrun breaker re-tripped immediately after reset | Each time it is reset, `gate.overrun_ack_micro` records the current ai overrun. |

The judges also flagged D2/D3 SQL races. They do not apply: there are no multi-statement TypeScript transactions, there is one global lock taken first, and every finish path checks state.

### 1.4 Deliberate simplifications (fewer moving parts)

- **No `GET /api/ai/requests/:id`.** A 202 is answered by re-POSTing the same body with the same `requestId`. That call is idempotent and never creates a second reservation. Shared-cache waiters land on `cached`.
- **No automatic model retry.** "Try again" in the UI means a new `requestId` and a new reservation.
- **The "memory" ledger is PGlite in memory running the same SQL.** There is no second TypeScript implementation of the money logic.
- **No admin dashboard, server-side queue, provider token pacing or lite mode.** The CLI and operator-only status JSON cover operations (deferred, §13).
- **No cron needed for correctness.**
  - Lease reaping runs inside every `reserve`.
  - Pending orders are verified by the return page.
  - `/api/ops/reconcile` exists for Cron or manual runs.

## 2. Phasing: six focused sessions

Each session ends with `npm test`, `npm run typecheck` and `npm run build` green, all offline.

| Session | Scope | Done when |
|---|---|---|
| S0 (Phase 0, about half a day, no DB) | `identity/keys.ts`, `identity/visitor.ts`. The `guard.ts` limiter is keyed by visitor. `isServerlessHost` fail-closed in `budgetFor`/status. `AiErrorCode` gains `ledger`. | `tests/identity.test.ts` passes. `VERCEL=1` with no `DATABASE_URL` gives 503 `ledger` and no fetch. Existing `ai.test.ts` stays green. |
| S1 | `pricing.ts`, `usage.ts`, the adapters return `NormalizedUsage` plus billing classes, `providers/fake.ts`, config additions, `worst-case.ts`. | `pricing`/`usage` tests pass. The file ledger is corrected immediately. |
| S2 | `sql/001`, `002` (free path plus admin, read and audit functions), `900`; `drivers.ts`, `migrate.ts`, `sql-ledger.ts`, `file-ledger.ts`, `factory.ts`, `plans.ts`, `hash.ts`, `levels.ts`. | `ledger.smoke/free/reaper/plan/concurrency/fuzz(free)` pass, and `audit()==[]` after every step. |
| S3 | `meter.ts`, `handler.ts`, the five routes, status, `http.ts`, browser `client.ts`. UI: requestId wiring, quota/budget/low-level lines, simulated label. | `meter`, `routes.ai`, `client` and `event-sim` pass. |
| S4 | Paid SQL functions (orders, lots, paid readings, webhook functions, `revoke_mode`), `payments/*`, `identity/auth.ts`, `identity/ops.ts`, the `/api/packs*`, webhook and `/api/ops/*` routes. | `ledger.paid`, `isolation`, `orders`, `webhook`, `payments.config`, `packs.flow` and `recovery` pass. Fuzz is extended with payments. |
| S5 | `PacksPanel` on `/me`, the paid opt-in on the reading page, TarotChat follow-ups, the fake checkout page, scripts (`ledger-admin`, `budget-plan`, `rehearse`), `.env.example`, privacy copy. | `ui-honesty` passes, `no-emoji` passes, and a manual fake-mode run works. |

## 3. Files and exported APIs

All server files `import "server-only"` (already stubbed in vitest). Money is integer micro-USD (`number`; every value is far below 2^53).

### 3.1 `src/lib/ai/`

```ts
// types.ts (modify)
export type Purpose = "tarot" | "chat" | "talk" | "natal" | "horoscope";
export interface Attempt { model: string | null; kind: "primary" | "fallback"; input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number }
export interface NormalizedUsage { attempts: Attempt[]; servedModel: string; complete: boolean } // complete=false -> charge the bound
export interface ProviderResult { text: string; model: string; usage: NormalizedUsage }
export interface GenerationMeta { provider: ProviderKind; model: string; generatedAt: string; costUsd: number } // internal only
export interface PublicMeta { provider: ProviderKind; model: string; generatedAt: string; source: "live" | "simulated" }
export type AiErrorCode = "unconfigured" | "timeout" | "upstream" | "bad_output" | "refused" | "budget" | "ledger";
export type ErrorBilling = "known" | "none" | "unknown";
export class AiError extends Error {
  constructor(code: AiErrorCode, message?: string, opts?: { usage?: NormalizedUsage; billing?: ErrorBilling; status?: number; rateLimited?: boolean; retryAfterS?: number });
  code: AiErrorCode; usage?: NormalizedUsage; billing: ErrorBilling /* default: usage ? "known" : "unknown" */; status?: number; rateLimited: boolean; retryAfterS?: number;
}

// capabilities.ts (modify): ProviderKind = "openai-compatible" | "openai" | "anthropic" | "fake"
// modelCaps("fake", *) = { temperature:false, tokenParam:"max_tokens", structured:"none", effort:null, fallbacks:false, defaultMaxOutput:1500 }
// defaultPrices(): kept for compatibility, now derived from pricing.ts (USD/MTok)

// config.ts (modify): AiConfig gains
//   fallbackModels: string[]; fallbackMaxHops: number; tokensPerByte: number;
//   maxOutput: Record<Purpose, number>; priceOverride: Partial<ModelPrice>;
// `prices: {input, output}` stays (tests read it).
export function aiConfigured(cfg: AiConfig, env?: EnvLike): boolean // key+model, or provider "fake" when allowed (see §7)

// pricing.ts (new)
export interface ModelPrice { inN: number; outN: number; cw5mN: number; cw1hN: number; crN: number } // integer nano-USD per token
export const PRICE_TABLE: Readonly<Record<string, ModelPrice>>;  // §6
export const PRICE_CEILING: ModelPrice;                           // component-wise max of table and legacy 15/60
export function priceFor(cfg: AiConfig, model: string | null): { price: ModelPrice; known: boolean }
export function maxPrice(ps: ModelPrice[]): ModelPrice
export function fallbackTargets(cfg: AiConfig): string[]           // [] when fallbacks are off or unsupported
export function costMicro(u: NormalizedUsage, cfg: AiConfig): { micro: number; unknownModels: string[] }
export function requestBoundMicro(req: JsonRequest, cfg: AiConfig): number // req.maxOutputTokens required
export function requestCostBound(req: JsonRequest, cfg: AiConfig): number  // USD, legacy name used by ai.test.ts = bound/1e6

// usage.ts (new)
export function fromAnthropic(res: unknown, requested: string): NormalizedUsage
export function fromOpenAi(body: unknown, requested: string): NormalizedUsage
export function fromOpenAiCompatible(body: unknown, requested: string): NormalizedUsage

// worst-case.ts (new): builds max-size synthetic requests through the real prompt builders
// (question 300 chars, 8 notes at NOTE_MAX, largest spread, full chat window, zh and en)
export function worstCaseBoundMicro(purpose: Purpose, cfg: AiConfig): number // max over locales and shapes

// providers/{anthropic,openai,openai-compatible}.ts (modify): return ProviderResult with NormalizedUsage.
// Error billing:
//   HTTP 400/401/403/404/413/422      -> billing "none"
//   429 and 529                       -> "none" + rateLimited + retryAfterS from the retry-after header
//   408, 5xx, timeout, connection     -> "unknown"
//   200 with stop_reason refusal or max_tokens -> "known" (usage reported)
// The SDK keeps maxRetries 0.
// providers/fake.ts (new)
export interface FakeScript { latencyMs?: number; fail?: "timeout" | "upstream_5xx" | "rate_limited" | "refusal" | "bad_json" | "max_tokens"; usage?: "typical" | "max" | "over_bound"; fallback?: boolean }
export function callFake(cfg: AiConfig, caps: ModelCaps, req: JsonRequest, script?: FakeScript): Promise<ProviderResult>
export function fakeScriptFromEnv(env: EnvLike, seed?: number): () => FakeScript // seeded per-call failure draws
// Replies port the rules of scripts/mock-ai.mjs (texts prefixed "[MOCK]"), so they pass validateTarot,
// validateChat, validateTalk, validateNatal and validateHoroscope. Result model = "simulated".
// Priced as FAKE_AI_PRICE_AS. Typical usage = 3800 in / 860 out; "max" = the bound inputs.

// provider.ts (modify)
export function callProvider(req: JsonRequest, cfg: AiConfig, deps?: { fetchImpl?: typeof fetch; fake?: FakeScript }): Promise<ProviderResult>
export function parseReply(text: string, caps: ModelCaps): unknown // existing extractJson/parseStrict logic
export { extractJson, generateJson, budgetFor, requestCostBound } // generateJson keeps its signature (legacy file Budget, eval scripts, ai.test.ts)
// generateJson on an AiError: billing "none" -> settle 0; "known" -> settle the cost; "unknown" -> keep the hold (today's semantics).

// meter.ts (new)
export interface MeterInput<T> {
  ledger: LedgerPort; cfg: AiConfig; keys: Keys;
  subjectKey: string; accountId?: string; quotaExempt?: boolean;
  purpose: Purpose; mode: "free" | "paid_reading" | "paid_followup"; requestId: string;
  req: JsonRequest; canonical: unknown; versions: string; validate: (d: unknown) => T | null;
  cacheScope: "subject" | "shared"; resultTtlSeconds: number;
  paid?: { readingHash: string; paidReadingId?: string };
}
export type MeterOutcome<T> =
  | { kind: "fresh" | "replayed"; value: T; meta: PublicMeta; paidReadingId?: string; followupsLeft?: number; budgetRatio?: number }
  | { kind: "in_progress"; retryAfterMs: number }
  | { kind: "denied"; reason: DenyReason; retryAfterS?: number }
  | { kind: "retry_new_key" } | { kind: "unavailable" } | { kind: "failed"; error: AiError };
export function meteredGenerate<T>(a: MeterInput<T>, deps?: { call?: typeof callProvider; sleep?: (ms: number) => Promise<void> }): Promise<MeterOutcome<T>>

// handler.ts (new): shared by the five routes
export interface AiRouteSpec<P, T> {
  purpose: Purpose;
  parse(body: unknown): P | null;
  preflight?(p: P): NextResponse | null;                    // crisis / bad_facts; runs before any ledger call
  build(p: P): Omit<JsonRequest, "maxOutputTokens">;
  validate(p: P): (d: unknown) => T | null;
  versions(p: P): string;
  respond(value: T, meta: PublicMeta, p: P): Record<string, unknown>;
  cacheScope?(p: P): "subject" | "shared";
  paid?(body: Record<string, unknown>, p: P, keys: Keys): { mode: "paid_reading" | "paid_followup"; readingHash: string; paidReadingId?: string } | null;
}
export function handleAi<P, T>(req: NextRequest, spec: AiRouteSpec<P, T>, deps?: { ledger?: LedgerPort; call?: typeof callProvider }): Promise<NextResponse>

// http.ts (modify)
export function aiErrorResponse(e: AiError): NextResponse   // unchanged mapping + "ledger" -> 503
export function meterResponse(o: MeterOutcome<unknown>, body?: Record<string, unknown>, extra?: { credits?: number | null }): NextResponse // §8.2

// guard.ts (modify)
export function hasAiAccess(req: NextRequest): boolean            // unchanged
export function checkAiAccess(req: NextRequest): "unconfigured" | "locked" | null // the limiter moves out
export function burstLimit(subjectKey: string, now?: number): boolean // 40/h per subject, file ledger only
export function resetAiLimits(): void
// clientKey() is deleted: IP is never an identity.

// client.ts (new, browser, "use client" safe)
export function newRequestId(): string // 16 bytes from crypto.getRandomValues, base64url (22 chars)
export type AiOutcome<T> =
  | { state: "done"; value: T; replayed: boolean; budgetLevel?: Level; paid?: { paidReadingId: string; followupsLeft: number } }
  | { state: "crisis" } | { state: "quota"; credits: number | null } | { state: "no_credits" } | { state: "needs_login" }
  | { state: "retry" } | { state: "offline"; reason: "unconfigured" | "locked" | "ledger" | "budget" | "paused" | "busy" | "network" | "paid_capacity" }
  | { state: "failed"; code: string };
export function requestAi<T>(path: string, body: Record<string, unknown>, o: { requestId: string; signal?: AbortSignal; maxWaitMs?: number /* 45000 */ }): Promise<AiOutcome<T>>
// Retry policy:
// - 202, 503 busy/cooldown and 429 subject_busy: re-POST the same body and id after retryAfter
//   (default 2000 ms, +/-30% jitter, capped at 5 s) until maxWaitMs.
// - A network error gets one retry.
// - 409 retry_new_key returns "retry"; the caller makes one new id.
```

### 3.2 `src/lib/identity/`

```ts
// keys.ts
export interface Keys { cookie: Buffer; input: Buffer; net: Buffer; ops: Buffer } // HKDF-SHA256(SESSION_SECRET, salt "moona-v1", info label), 32 bytes each
export function serverKeys(env?: EnvLike): Keys | null // null when SESSION_SECRET is missing on a deployed host; local dev uses a fixed dev secret and warns once
export function isServerlessHost(env?: EnvLike): boolean // VERCEL || AWS_LAMBDA_FUNCTION_NAME || NETLIFY || K_SERVICE
export function isDeployed(env?: EnvLike): boolean        // isServerlessHost || MOONA_DEPLOYED === "1"

// visitor.ts
export const VISITOR_COOKIE = "moona_vid"; // value "v1.<uuid>.<base64url HMAC(keys.cookie, 'v1.'+uuid)>"
export function readVisitor(req: NextRequest, keys: Keys): string | null // timingSafeEqual; a forged or garbled cookie counts as absent
export function netBucket(req: NextRequest, keys: Keys, now?: Date): string // HMAC(keys.net, utcDay + IPv4 /24 | IPv6 /48); never stored raw
export function ensureVisitor(req: NextRequest, ledger: LedgerPort, keys: Keys): Promise<{ id: string; set?: { name: string; value: string; options: CookieOpts } } | { denied: "visitor_cap" }>
// options: { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: 15552000 }
// Minting is lazy: only once a request reaches the ledger stage.

// ops.ts (operator devices)
export const OPS_COOKIE = "moona_ops"; // "v1.<expEpoch>.<HMAC(keys.ops)>", 12 h
export function isOperator(req: NextRequest, keys: Keys): boolean
export function opsCookieValue(keys: Keys, ttlS?: number): string

// auth.ts (account port; the real provider is undecided)
export interface AuthPort { kind: "none" | "fake" | (string & {}); ready: boolean; getAccount(req: NextRequest, ctx: { visitorId: string | null; ledger: LedgerPort; isOperator: boolean }): Promise<{ accountId: string } | null> }
export function authFromEnv(env: EnvLike): AuthPort
// none: ready=false.
// fake: ready when !isDeployed or the caller is an operator; account = ensureAccount("fake", visitorId).
//   Credits are tied to that browser and the UI says so.
```

### 3.3 `src/lib/ledger/`

```ts
// port.ts
export type ReqMode = "free" | "paid_reading" | "paid_followup";
export type Billing = "known" | "none" | "unknown" | "bound";
export type DenyReason = "plan_unsynced" | "key_reused" | "paused" | "cooldown" | "busy" | "subject_busy" | "no_window" | "total_usd"
  | "window_usd" | "window_calls" | "slice_usd" | "purpose_closed" | "subject_quota" | "subject_failures" | "no_credits"
  | "no_such_reading" | "reading_mismatch" | "no_followups" | "lot_closed" | "paid_capacity";
export interface StoredResult { value: unknown; meta: PublicMeta }
export interface RequestView { id: string; state: "calling" | "succeeded" | "failed" | "expired"; mode: ReqMode; purpose: Purpose; errorCode: string | null; result: StoredResult | null; paidReadingId: string | null; followupsLeft: number | null }
export interface ReserveRequest { idemKey: string; subjectKey: string; accountId?: string; cacheScope: string; purpose: Purpose; mode: ReqMode; inputHash: string; boundMicro: number; quotaExempt?: boolean; paidReadingId?: string; readingHash?: string }
export type ReserveOutcome =
  | { status: "reserved"; requestId: string; leaseExpiresAt: string }
  | { status: "existing" | "cached"; request: RequestView }
  | { status: "in_progress"; requestId: string }
  | { status: "denied"; reason: DenyReason; retryAfterS?: number };
export interface CompleteRequest { requestId: string; chargedMicro: number; billing: "known" | "bound"; usage: NormalizedUsage | null; result: StoredResult; resultTtlSeconds: number; readingHash?: string }
export type CompleteOutcome = { status: "succeeded" | "already"; request: RequestView; overrunMicro?: number; budgetRatio?: number } | { status: "late" } | { status: "conflict" };
export interface FailRequest { requestId: string; billing: Billing; chargedMicro?: number; usage: NormalizedUsage | null; errorCode: string; rateLimited?: boolean; retryAfterS?: number }
export type FailOutcome = { status: "failed"; chargedMicro: number; overrunMicro: number } | { status: "already" | "late" };
export type PayMode = "fake" | "test" | "live";
export interface OrderView { id: string; state: "pending" | "paid" | "expired" | "canceled" | "paid_unfunded" | "needs_review" | "revoked"; mode: PayMode; holds: boolean; amountCents: number; currency: string; readings: number; followupsPerReading: number; checkoutExpiresAt: string; sessionId: string | null; checkoutUrl: string | null; reviewNote: string | null; creditsLeft: number | null; lotState: string | null; createdAt: string; paidAt: string | null }
export type OrderOutcome = { status: "created" | "existing" | "pending_exists"; order: OrderView } | { status: "denied"; reason: "plan_unsynced" | "sales_closed" | "no_product" | "sold_out" | "budget_short" };
export interface FulfilRequest { eventId: string; type: string; orderId: string | null; sessionId: string; paymentId: string | null; amountCents: number | null; currency: string | null; livemode: boolean; paid: boolean }
export type FulfilOutcome = "duplicate_event" | "unknown_order" | "session_mismatch" | "mode_mismatch" | "not_paid" | "already" | "amount_mismatch" | "paid_unfunded" | "granted";
export interface EntitlementView { credits: number; readings: { paidReadingId: string; followupsLeft: number; lotOpen: boolean }[]; orders: OrderView[]; unservable: boolean }
export interface PoolView { id: string; kind: string; capMicro: number; spentMicro: number; heldMicro: number; overrunMicro: number; callsCap: number | null; callsUsed: number; startsAt: string | null; endsAt: string | null }
export type LedgerSnapshot =
  | { kind: "sql"; planId: string | null; planHash: string | null; pools: PoolView[]; activeWindowId: string | null; gate: { inflight: number; breaker: "ok" | "tripped"; breakerReason: string | null; sales: "open" | "closed"; salesReason: string | null; cooldownUntil: string | null }; sold: { test: number; live: number }; owedReadings: number; reviewOrders: number }
  | { kind: "file"; legacy: BudgetSnapshot };
export interface AuditRow { check: string; subject: string; expected: number; actual: number }
export interface LedgerPort {
  readonly kind: "sql" | "file"; readonly supportsPaid: boolean;
  reserve(r: ReserveRequest): Promise<ReserveOutcome>;
  complete(r: CompleteRequest): Promise<CompleteOutcome>;
  fail(r: FailRequest): Promise<FailOutcome>;
  mintVisitor(netBucket: string): Promise<{ ok: true } | { ok: false; reason: "mint_cap" | "mint_net" | "plan_unsynced" }>;
  snapshot(): Promise<LedgerSnapshot>;
  reap(limit?: number): Promise<number>;
  purgeResults(): Promise<number>;
  audit(): Promise<AuditRow[]>;
  setFlag(key: "breaker" | "sales", value: "ok" | "tripped" | "open" | "closed", reason: string): Promise<void>;
  // paid (the file ledger throws LedgerUnsupported)
  ensureAccount(provider: string, subject: string): Promise<string>;
  entitlements(accountId: string): Promise<EntitlementView>;
  createOrder(r: { accountId: string; productId: string; mode: PayMode; checkoutKey: string }): Promise<OrderOutcome>;
  attachSession(r: { orderId: string; sessionId: string; url: string }): Promise<"attached" | "not_pending">;
  viewOrder(orderId: string, accountId: string): Promise<OrderView | null>;
  ordersToVerify(limit?: number): Promise<OrderView[]>;
  fulfil(e: FulfilRequest): Promise<FulfilOutcome>;
  expireOrder(e: { eventId: string; sessionId: string; kind: "expired" | "async_failed" }): Promise<string>;
  revokeOrder(e: { eventId: string; kind: "refund_full" | "refund_partial" | "dispute"; paymentId?: string | null; orderId?: string | null }): Promise<string>;
}
export interface AdminLedger extends LedgerPort { syncPlan(p: SyncPlanPayload): Promise<void>; recordSpend(e: { entryId: string; pools: string[]; amountMicro: number; kind: string; note: string }): Promise<"recorded" | "duplicate">; revokeMode(): Promise<number> }
export class LedgerUnavailable extends Error { constructor(public reason: "ledger_down" | "ledger_nondurable" | "plan_unsynced", message?: string) }
export class LedgerUnsupported extends Error {}

// sql-ledger.ts
export interface SqlExecutor { query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>; exec(sql: string): Promise<void>; close(): Promise<void> }
export function createSqlLedger(exec: SqlExecutor, o?: { clock?: () => Date }): AdminLedger
// Every call is `select moona.<fn>($1::jsonb) as r` with [JSON.stringify(snakeCasePayload)].
// fn comes from a const allowlist. `clock` adds "now" to every payload; it only takes effect with 900_test_clock.
// Errors:
//   SQLSTATE 08*, 53300, 55P03, 57014, 57P01, 57P03, and ECONNREFUSED/ETIMEDOUT/ENOTFOUND -> LedgerUnavailable("ledger_down")
//   P0001 / 23*                                                                  -> rethrown (bug; 500, never call the provider)

// drivers.ts
export function pgExecutor(url: string, o?: { max?: number; queryTimeoutMs?: number; caCert?: string }): SqlExecutor
// new pg.Pool({ connectionString, max (default 2), query_timeout (4000), connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000,
//   ssl: localhost ? false : { rejectUnauthorized: true, ca } }), cached on globalThis.
// Supabase: transaction pooler URL (port 6543). pg uses unnamed statements unless `name` is passed.
// lock_timeout is a per-function SET, so the pooler is fine.
export function pgliteExecutor(dataDir?: string): Promise<SqlExecutor>
// const { PGlite } = await import("@electric-sql/pglite"); db = new PGlite(dataDir) (memory when omitted)
// query -> db.query(text, params); exec -> db.exec(sql)

// migrate.ts
export function migrate(exec: SqlExecutor, o?: { testClock?: boolean; roles?: boolean }): Promise<string[]>
// Creates moona.schema_migrations(version, checksum, applied_at). Each file runs in begin/commit.
// - 001: immutable (a checksum mismatch after apply is an error).
// - 002: re-applied whenever its sha256 changes (create or replace; signature changes need an explicit drop at the top).
// - 003: only with roles=true (real Postgres).
// - 900: only with testClock=true, always applied after 002.
// Files are read from path.join(process.cwd(), "src/lib/ledger/sql"). Migrate is never called on the request path in production.

// file-ledger.ts (wraps the existing Budget: local single-process development only)
export function createFileLedger(budget: Budget): LedgerPort
// Free mode only; supportsPaid=false.
// reserve -> budget.reserveRequest(bound/1e6) (daily_calls -> window_calls, daily_usd -> window_usd, total_usd -> total_usd).
//   No idempotency, cache or quotas (a documented local-dev limitation).
// complete -> settle(cost); fail none -> settle(0); known -> settle(cost); unknown/bound -> keep the hold.
// snapshot -> { kind: "file", legacy }.

// factory.ts
export function getLedger(env?: EnvLike): Promise<{ ok: true; ledger: LedgerPort } | { ok: false; reason: "ledger_down" | "ledger_nondurable" }>
export function setLedgerForTests(l: LedgerPort | null): void
// MOONA_LEDGER=auto (default):
//   - DATABASE_URL set              -> postgres
//   - else on a serverless host     -> ledger_nondurable
//   - else                          -> file (legacy Budget at AI_USAGE_FILE or .data/ai-usage.json)
// postgres | pglite (MOONA_PGLITE_DIR) | memory | file can be named explicitly.
// pglite, memory and file on a serverless host -> ledger_nondurable.
// pglite/memory run migrate + syncPlan(resolvePlan(env)) once per process (development convenience).
// postgres never migrates or syncs; if the DB plan_hash differs from the env plan, it warns once (shown to operators).
// the server checks moona.functions_version() against LEDGER_FUNCTIONS_VERSION (ledger/version.ts) before it uses any SQL
// ledger, and so does every ledger-admin command except migrate; on any other version it refuses (fails closed).
// After a 002 change, run `npm run ledger -- migrate` (with --roles on Postgres) before the new code serves.

// plans.ts
export interface WindowPlan { id: string; startsAt: string; endsAt: string; capUsd: number; callsCap: number | null; slice: { capUsd: number; seconds: 3600 | 86400 } | null; mintCap: number | null; quotas: Record<Purpose, { perSubject: number; failedCap: number }> }
export interface BudgetPlan { id: "dev" | "event-2026-10-28"; cashTotalUsd: number; aiUsd: number; hostingUsd: number; reserveUsd: number; packPoolUsd: number; packSlackUsd: number; windows: WindowPlan[]; inflightCap: number; subjectInflightCap: number; leaseSeconds: number; overrunTripUsd: number; unknownTrip: number; unknownCooldownS: number; rlTrip: number; rlWindowS: number; rlCooldownS: number; mintNetLimit: number; mintNetWindowS: number; warnAt: [number, number, number] }
export interface ProductPlan { id: "tarot5"; amountCents: number; currency: string; readings: number; followupsPerReading: number; attemptsPerUnit: number; allocMicro: number; feeHoldMicro: number; maxSoldTest: number; maxSoldLive: number }
export interface SyncPlanPayload { plan: Record<string, unknown>; pools: Record<string, unknown>[]; quotas: Record<string, unknown>[]; products: Record<string, unknown>[] } // §4.2 sync_plan
export interface ResolvedPlan { plan: BudgetPlan; product: ProductPlan; hash: string; sync: SyncPlanPayload; bounds: Record<Purpose, number>; priorSpendMicro: number }
export const PLANS: Readonly<Record<BudgetPlan["id"], BudgetPlan>>;
export function resolvePlan(env: EnvLike, cfg: AiConfig): ResolvedPlan // MOONA_PLAN + env overrides; hash = sha256(canonicalJson(sync without hash))
export function validatePlan(r: ResolvedPlan, cfg: AiConfig): { errors: string[]; warnings: string[] } // §7.4

// hash.ts
export function canonicalJson(v: unknown): string // sorted keys, undefined dropped
export function inputHash(k: Buffer, x: unknown): string                     // hex HMAC-SHA256
export function idemKey(k: Buffer, subjectKey: string, purpose: Purpose, requestId: string): string
export function readingHash(k: Buffer, r: { spread: string; topic: string; question?: string; cards: { id: string; reversed: boolean }[] }): string // locale excluded

// levels.ts
export type Level = "ok" | "notice" | "warn" | "critical" | "exhausted";
export function budgetLevel(s: LedgerSnapshot, warnAt: [number, number, number], nextBoundMicro: number, now?: Date): { level: Level; ratio: number; poolId: string | null }
// ratio = max over ai, the active window, its current slice and reserve of (spent+held)/cap.
// "exhausted" when the next typical bound no longer fits the binding pool.
```

### 3.4 `src/lib/payments/`

```ts
// config.ts
export type PaymentsState = "unconfigured" | "misconfigured" | "fake" | "test" | "live";
export interface PaymentsConfig { state: PaymentsState; requested: string; problems: string[]; webhookEnabled: boolean; secretKey?: string; webhookSecret?: string; priceId?: string; termsUrl?: string; refundUrl?: string; supportContact?: string; siteUrl: string }
export function paymentsConfig(env: EnvLike, ctx: { ledgerKind: "postgres" | "pglite" | "memory" | "file" | null; authKind: string }): PaymentsConfig // rules in §7.3

// port.ts
export interface CheckoutSession { id: string; url: string | null; status: "open" | "complete" | "expired"; paymentStatus: "paid" | "unpaid" | "no_payment_required"; amountTotal: number | null; currency: string | null; paymentIntentId: string | null; livemode: boolean; orderId: string | null }
export type NormalizedPaymentEvent =
  | { id: string; kind: "paid" | "unpaid"; orderId: string | null; sessionId: string; paymentId: string | null; amountCents: number | null; currency: string | null; livemode: boolean }
  | { id: string; kind: "expired" | "async_failed"; sessionId: string; livemode: boolean }
  | { id: string; kind: "refund_full" | "refund_partial" | "dispute"; paymentId: string | null; orderId: string | null; livemode: boolean }
  | { id: string; kind: "ignored"; type: string; livemode: boolean };
export interface PaymentsPort {
  readonly state: "fake" | "test" | "live";
  createCheckout(o: { orderId: string; checkoutExpiresAt: Date; successUrl: string; cancelUrl: string }): Promise<{ sessionId: string; url: string }>;
  retrieve(sessionId: string): Promise<CheckoutSession>;
  expire(sessionId: string): Promise<void>;
  verifyWebhook(raw: string, signature: string | null): NormalizedPaymentEvent; // throws WebhookSignatureError
}
export class WebhookSignatureError extends Error {}
export function paymentsFromConfig(cfg: PaymentsConfig, deps?: { stripe?: StripeLike }): PaymentsPort | null

// stripe.ts
export interface StripeLike { checkout: { sessions: { create(p: object, o: { idempotencyKey: string }): Promise<any>; retrieve(id: string): Promise<any>; expire(id: string): Promise<any> } }; webhooks: { constructEvent(raw: string, sig: string, secret: string): any; generateTestHeaderString(o: { payload: string; secret: string; timestamp?: number }): string } }
export function createStripePayments(cfg: PaymentsConfig, stripe?: StripeLike): PaymentsPort // default: new Stripe(cfg.secretKey!, { maxNetworkRetries: 1, timeout: 10000 })
export function normalizeStripeEvent(ev: { id: string; type: string; livemode: boolean; data: { object: any } }): NormalizedPaymentEvent
// createCheckout -> stripe.checkout.sessions.create({
//   mode: "payment", line_items: [{ price: cfg.priceId, quantity: 1 }], payment_method_types: ["card"],
//   client_reference_id: orderId, metadata: { order_id: orderId }, payment_intent_data: { metadata: { order_id: orderId } },
//   success_url, cancel_url, expires_at: Math.floor(checkoutExpiresAt.getTime() / 1000) }, { idempotencyKey: `order:${orderId}` })
// Events:
//   checkout.session.completed            -> paid if payment_status === "paid", else unpaid
//   checkout.session.async_payment_succeeded -> paid
//   checkout.session.async_payment_failed -> async_failed
//   checkout.session.expired              -> expired
//   charge.refunded                       -> refund_full when amount_refunded >= amount, else refund_partial (paymentId = charge.payment_intent)
//   charge.dispute.created                -> dispute (paymentId = dispute.payment_intent)
//   anything else                         -> ignored
// Metadata carries only the opaque order id: no birth data, question or reading text.

// fake.ts (state "fake"; allowed only when !isDeployed or PAYMENTS_ALLOW_FAKE_ON_DEPLOY=1)
export function createFakePayments(cfg: PaymentsConfig): PaymentsPort & { deliver(orderId: string, outcome: "pay" | "unpaid" | "decline" | "expire" | "refund" | "partial_refund" | "dispute", o?: { duplicate?: boolean }): Promise<string[]> }
// Session id "cs_fake_<orderId>"; url "/packs/fake-checkout/<orderId>". Sessions live in a process-local map.
// deliver() builds Stripe-shaped event JSON (livemode false), signs it with
// stripe.webhooks.generateTestHeaderString({ payload, secret: FAKE_WEBHOOK_SECRET }), and calls the webhook
// handler function, so the real verification path runs.

// service.ts
export function startCheckout(c: { ledger: LedgerPort; pay: PaymentsPort; accountId: string; productId: string; checkoutKey: string; siteUrl: string }): Promise<{ url: string; orderId: string } | { denied: string }>
export function handlePaymentEvent(ledger: LedgerPort, e: NormalizedPaymentEvent): Promise<string>
export function handleWebhook(raw: string, signature: string | null, deps: { ledger: () => Promise<LedgerPort>; pay: PaymentsPort; cfg: PaymentsConfig }): Promise<{ status: 200 | 400 | 404 | 503 | 500; body: Record<string, unknown> }>
export function syncOrder(ledger: LedgerPort, pay: PaymentsPort, orderId: string, accountId: string): Promise<OrderView | null>
export function reconcile(ledger: LedgerPort, pay: PaymentsPort | null): Promise<{ reaped: number; ordersSynced: number; purged: number; audit: AuditRow[] }>
export type SalesReason = "unconfigured" | "misconfigured" | "operators_only" | "login_unavailable" | "ledger" | "paused" | "closed" | "no_pack_pool" | "sold_out" | "budget_short";
export function salesState(cfg: PaymentsConfig, snap: LedgerSnapshot | null, ctx: { isOperator: boolean; deployed: boolean; authReady: boolean; product: ProductPlan; packSlackMicro: number }): { open: boolean; reason: SalesReason | null }
export function purchaseAction(state: PaymentsState, open: boolean, ctx: { isOperator: boolean; deployed: boolean }): null | { kind: "buy" | "test" | "simulate" }

// copy.ts: selects strings from i18n m.packs.* (§10.4)
export function packsCopy(m: Messages, state: PaymentsState, sales: { open: boolean; reason: SalesReason | null }, action: ReturnType<typeof purchaseAction>): { eyebrow: string; title: string; body: string; cta: string | null; badge: "test" | "sim" | null }
```

### 3.5 Routes, UI, scripts, config (modify or new)

**API routes**
- **AI, modified:** `src/app/api/ai/{tarot,chat,talk,natal,horoscope}/route.ts` and `status/route.ts`.
- **Packs, new:** `src/app/api/packs/route.ts`, `packs/checkout/route.ts`, `packs/orders/[id]/route.ts`.
- **Stripe, new:** `src/app/api/stripe/webhook/route.ts`.
- **Operator, new:** `src/app/api/ops/session/route.ts`, `ops/reconcile/route.ts`, `ops/fake-pay/route.ts`.

**UI**
- **New:** `src/app/packs/fake-checkout/[id]/page.tsx` and `src/components/packs/{PacksPanel,PaymentModeBanner,CreditMeter}.tsx`.
- **Modified pages and components:** `src/app/me/page.tsx`, `src/app/tarot/r/[id]/page.tsx`, `src/components/TarotChat.tsx`, `HoroscopePanel.tsx`, `NatalReport.tsx`, `chat/Conversation.tsx`, `src/app/page.tsx`, `src/components/bits.tsx` (`SourceBadge`).
- **Modified data, copy and styles:** `src/lib/tarot/types.ts`, `src/lib/i18n/{en,zh}.ts`, `src/app/globals.css`, and the `src/app/about` privacy text.

**Scripts:** `scripts/ledger-admin.ts`, `scripts/budget-plan.ts`, `scripts/rehearse.ts` (optional). All three are run with `npx tsx`.

**Config files**
- `next.config.ts` gets `serverExternalPackages: ["@electric-sql/pglite"]`; it only matters for `MOONA_LEDGER=pglite|memory` under `next dev` or `next start`.
- `package.json`, `.env.example`.

## 4. SQL (Postgres dialect; identical files run in PGlite 0.5)

**Function rules**
- **Uniform signature.** Every public function is `moona.<fn>(p jsonb) returns jsonb`, `security definer`, `set search_path = pg_catalog, pg_temp`, `set lock_timeout = '2s'`, and every name is schema-qualified.
- **Lock first.** Every mutating function calls `moona._lock()` first. That is the global mutex: `gate` row 1 `FOR UPDATE`.
- **The one exception is `ensure_account`.** It is a single insert that waits on no other lock.
- **Read-only functions take no locks.**

### 4.1 `src/lib/ledger/sql/001_schema.sql`

```sql
create schema if not exists moona;

create table moona.plan (
  id boolean primary key default true check (id),
  plan_id text not null, plan_hash text not null,
  cash_total_micro bigint not null check (cash_total_micro >= 0),
  overrun_trip_micro bigint not null check (overrun_trip_micro >= 0),
  inflight_cap int not null check (inflight_cap > 0),
  subject_inflight_cap int not null check (subject_inflight_cap > 0),
  lease_seconds int not null check (lease_seconds between 30 and 900),
  unknown_trip int not null check (unknown_trip > 0), unknown_cooldown_s int not null check (unknown_cooldown_s >= 0),
  rl_trip int not null check (rl_trip > 0), rl_window_s int not null check (rl_window_s > 0), rl_cooldown_s int not null check (rl_cooldown_s >= 0),
  mint_net_limit int not null check (mint_net_limit > 0), mint_net_window_s int not null check (mint_net_window_s > 0),
  checkout_ttl_s int not null check (checkout_ttl_s between 1860 and 86000),
  pack_slack_micro bigint not null check (pack_slack_micro >= 0),
  synced_at timestamptz not null);

create table moona.gate (                               -- row 1 = the global ledger mutex + provider health + flags
  id smallint primary key check (id = 1),
  inflight int not null default 0 check (inflight >= 0),
  unknown_streak int not null default 0 check (unknown_streak >= 0),
  rl_hits int not null default 0 check (rl_hits >= 0), rl_window_start timestamptz,
  cooldown_until timestamptz,
  breaker text not null default 'ok' check (breaker in ('ok','tripped')), breaker_reason text,
  overrun_ack_micro bigint not null default 0 check (overrun_ack_micro >= 0),
  sales text not null default 'open' check (sales in ('open','closed')), sales_reason text,
  updated_at timestamptz not null default now());
insert into moona.gate (id) values (1);

create table moona.pools (
  id text primary key,       -- 'ai' | 'packs' | 'hosting' | 'reserve' | 'win:<name>' | 'slice:<win>:<YYYYMMDDTHHMMZ>'
  kind text not null check (kind in ('ai','packs','hosting','reserve','window','slice')),
  parent_id text references moona.pools(id),
  cap_micro bigint not null check (cap_micro >= 0),
  spent_micro bigint not null default 0 check (spent_micro >= 0),
  held_micro bigint not null default 0 check (held_micro >= 0),
  overrun_micro bigint not null default 0 check (overrun_micro >= 0),
  calls_cap int check (calls_cap >= 0),
  calls_used int not null default 0 check (calls_used >= 0),
  slice_cap_micro bigint check (slice_cap_micro > 0),
  slice_seconds int check (slice_seconds in (3600, 86400)),
  mint_cap int check (mint_cap >= 0), minted int not null default 0 check (minted >= 0),
  starts_at timestamptz, ends_at timestamptz,
  check ((kind in ('window','slice')) = (starts_at is not null and ends_at is not null)),
  check (starts_at is null or starts_at < ends_at),
  check ((kind = 'slice') = (parent_id is not null)),
  check ((slice_cap_micro is null) = (slice_seconds is null)),
  check (kind = 'window' or (slice_cap_micro is null and mint_cap is null)));

create table moona.free_quotas (
  window_id text not null references moona.pools(id), purpose text not null,
  per_subject int not null check (per_subject >= 0), failed_cap int not null check (failed_cap >= 0),
  primary key (window_id, purpose));

create table moona.subject_usage (
  subject_key text not null,                          -- 'v:<uuid>' (signed visitor cookie); never an IP
  window_id text not null references moona.pools(id), purpose text not null,
  reserved int not null default 0 check (reserved >= 0),
  used int not null default 0 check (used >= 0),
  failed int not null default 0 check (failed >= 0),
  primary key (subject_key, window_id, purpose));

create table moona.rate_windows (key text not null, window_start timestamptz not null, count int not null check (count >= 0),
  primary key (key, window_start));                  -- 'mint:<net bucket HMAC>'

create table moona.accounts (
  id uuid primary key default gen_random_uuid(), provider text not null, subject text not null,
  created_at timestamptz not null, unique (provider, subject));

create table moona.products (
  id text primary key, active boolean not null,
  amount_cents int not null check (amount_cents > 0), currency text not null check (currency ~ '^[a-z]{3}$'),
  readings int not null check (readings > 0), followups_per_reading int not null check (followups_per_reading >= 0),
  alloc_micro bigint not null check (alloc_micro > 0), fee_hold_micro bigint not null check (fee_hold_micro >= 0),
  max_sold_test int not null check (max_sold_test >= 0), max_sold_live int not null check (max_sold_live >= 0));

create table moona.orders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references moona.accounts(id),
  product_id text not null references moona.products(id),
  mode text not null check (mode in ('fake','test','live')),
  state text not null check (state in ('pending','paid','expired','canceled','paid_unfunded','needs_review','revoked')),
  holds boolean not null,                              -- alloc held on ai+packs and fee hold on reserve
  amount_cents int not null check (amount_cents > 0), currency text not null,
  readings int not null check (readings > 0), followups_per_reading int not null check (followups_per_reading >= 0),
  alloc_micro bigint not null check (alloc_micro > 0), fee_hold_micro bigint not null check (fee_hold_micro >= 0),
  checkout_key text not null, checkout_expires_at timestamptz not null,
  provider_session_id text unique, provider_payment_id text unique, checkout_url text, review_note text,
  created_at timestamptz not null, paid_at timestamptz, closed_at timestamptz,
  unique (account_id, checkout_key),
  check (not holds or state in ('pending','needs_review')),
  check (state <> 'pending' or holds));
create unique index orders_one_pending on moona.orders (account_id) where state = 'pending';
create index orders_pending on moona.orders (created_at) where state = 'pending';

create table moona.lots (
  order_id uuid primary key references moona.orders(id),    -- at most one lot per order
  account_id uuid not null references moona.accounts(id), mode text not null,
  state text not null check (state in ('open','revoking','closed','revoked')),
  readings_total int not null check (readings_total > 0),
  readings_reserved int not null default 0 check (readings_reserved >= 0),
  readings_used int not null default 0 check (readings_used >= 0),
  followups_per_reading int not null check (followups_per_reading >= 0),
  alloc_micro bigint not null check (alloc_micro > 0),
  alloc_held_micro bigint not null default 0 check (alloc_held_micro >= 0),
  alloc_spent_micro bigint not null default 0 check (alloc_spent_micro >= 0),
  created_at timestamptz not null, closed_at timestamptz,
  check (readings_reserved + readings_used <= readings_total),
  check (alloc_held_micro + alloc_spent_micro <= alloc_micro));
create index lots_open on moona.lots (account_id, created_at) where state = 'open';

create table moona.paid_readings (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references moona.lots(order_id), account_id uuid not null references moona.accounts(id),
  request_id uuid not null unique,                         -- FK added below
  reading_hash bytea not null,
  followups_total int not null check (followups_total >= 0),
  followups_reserved int not null default 0 check (followups_reserved >= 0),
  followups_used int not null default 0 check (followups_used >= 0),
  created_at timestamptz not null default now(),
  check (followups_reserved + followups_used <= followups_total));

create table moona.requests (
  id uuid primary key,
  idem_key bytea not null unique,                          -- HMAC(subject|purpose|client requestId)
  subject_key text not null check (subject_key ~ '^[va]:[0-9a-f-]{36}$'),
  account_id uuid references moona.accounts(id),
  cache_scope text not null,                               -- = subject_key, or 'shared'
  purpose text not null check (purpose in ('tarot','chat','talk','natal','horoscope')),
  mode text not null check (mode in ('free','paid_reading','paid_followup')),
  input_hash bytea not null,                               -- HMAC(canonical input + versions + provider + model + max output)
  window_id text references moona.pools(id), slice_id text references moona.pools(id),
  lot_id uuid references moona.lots(order_id), paid_reading_id uuid references moona.paid_readings(id),
  bound_micro bigint not null check (bound_micro > 0),
  take_micro bigint not null default 0 check (take_micro >= 0),     -- paid: drawn from the lot allocation
  extra_micro bigint not null default 0 check (extra_micro >= 0),   -- paid: shortfall held on packs+ai
  charged_micro bigint check (charged_micro >= 0), lot_charged_micro bigint check (lot_charged_micro >= 0),
  state text not null check (state in ('calling','succeeded','failed','expired')),
  billing text check (billing in ('known','none','unknown','bound')),
  lease_expires_at timestamptz not null,
  result jsonb, result_expires_at timestamptz, result_purged boolean not null default false,
  usage jsonb, error_code text, created_at timestamptz not null, finished_at timestamptz,
  check ((mode = 'free') = (window_id is not null)),
  check (mode = 'free' or slice_id is null),
  check ((mode = 'free') = (lot_id is null)),
  check ((mode = 'paid_followup') = (paid_reading_id is not null)),
  check (mode <> 'free' or (take_micro = 0 and extra_micro = 0)),
  check (mode = 'free' or take_micro + extra_micro = bound_micro),
  check ((state = 'calling') = (charged_micro is null)),
  check ((state = 'calling') = (finished_at is null)),
  check (mode = 'free' or state = 'calling' or lot_charged_micro is not null),
  check (state <> 'succeeded' or result is not null or result_purged));
create unique index requests_free_inflight on moona.requests (cache_scope, purpose, input_hash) where state = 'calling' and mode = 'free';
create index requests_cache on moona.requests (cache_scope, purpose, input_hash, finished_at desc) where state = 'succeeded' and mode = 'free';
create index requests_lease on moona.requests (lease_expires_at) where state = 'calling';
create index requests_subject_calling on moona.requests (subject_key) where state = 'calling';
create index requests_lot_calling on moona.requests (lot_id) where state = 'calling' and lot_id is not null;
create index requests_ttl on moona.requests (result_expires_at) where result is not null and not result_purged;
alter table moona.paid_readings add constraint paid_readings_request_fk foreign key (request_id) references moona.requests(id);

create table moona.payment_events (
  event_id text primary key,                               -- evt_..., 'sync:paid:<cs>', 'sync:expired:<cs>'
  type text not null, order_id uuid, outcome text not null, received_at timestamptz not null);

create table moona.entries (
  entry_id text not null, pool_id text not null references moona.pools(id),
  kind text not null check (kind in ('prior_spend','manual_spend','fee_estimate','dispute_fee','provider_correction')),
  amount_micro bigint not null, order_id uuid, note text not null default '', created_at timestamptz not null,
  primary key (entry_id, pool_id));

alter table moona.plan enable row level security;          alter table moona.gate enable row level security;
alter table moona.pools enable row level security;         alter table moona.free_quotas enable row level security;
alter table moona.subject_usage enable row level security; alter table moona.rate_windows enable row level security;
alter table moona.accounts enable row level security;      alter table moona.products enable row level security;
alter table moona.orders enable row level security;        alter table moona.lots enable row level security;
alter table moona.paid_readings enable row level security; alter table moona.requests enable row level security;
alter table moona.payment_events enable row level security; alter table moona.entries enable row level security;
-- No policies. The owner bypasses RLS; moona_app has no table privileges at all (003).
```

### 4.2 `src/lib/ledger/sql/002_functions.sql`

```sql
-- Helpers (security invoker; called only from the definer functions below; EXECUTE revoked from public in 003)
create or replace function moona._clock(p jsonb) returns timestamptz
language sql volatile set search_path = pg_catalog, pg_temp as $$ select clock_timestamp() $$;   -- production: ignores p

create or replace function moona._lock() returns moona.gate
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare g moona.gate;
begin select * into strict g from moona.gate where id = 1 for update; return g; end $$;

create or replace function moona._deny(reason text) returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$ select jsonb_build_object('status','denied','reason',reason) $$;

create or replace function moona._view(r moona.requests) returns jsonb language sql stable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('id', r.id, 'state', r.state, 'mode', r.mode, 'purpose', r.purpose, 'error_code', r.error_code,
    'result', case when r.result_purged then null else r.result end,
    'paid_reading_id', x.id,
    'followups_left', x.followups_total - x.followups_used - x.followups_reserved)
  from (select 1) one
  left join moona.paid_readings x
    on x.id = coalesce(r.paid_reading_id, (select y.id from moona.paid_readings y where y.request_id = r.id)) $$;

create or replace function moona._order_view(o moona.orders) returns jsonb language sql stable
set search_path = pg_catalog, pg_temp as $$
  select (to_jsonb(o) - 'checkout_key') || jsonb_build_object(
    'credits_left', (select l.readings_total - l.readings_used - l.readings_reserved from moona.lots l where l.order_id = o.id and l.state = 'open'),
    'lot_state', (select l.state from moona.lots l where l.order_id = o.id)) $$;

create or replace function moona._event(p_id text, p_outcome text) returns jsonb
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin update moona.payment_events set outcome = p_outcome where event_id = p_id;
      return jsonb_build_object('status', p_outcome); end $$;

create or replace function moona._pool_settle(p_id text, p_release bigint, p_charge bigint, p_over bigint, p_uncall int)
returns void language sql set search_path = pg_catalog, pg_temp as $$
  update moona.pools set held_micro = held_micro - p_release, spent_micro = spent_micro + p_charge,
         overrun_micro = overrun_micro + p_over, calls_used = calls_used - p_uncall where id = p_id $$;

-- Settle one 'calling' request exactly once (caller holds the lock).
create or replace function moona._settle(r moona.requests, p_state text, p_charge bigint, p_billing text,
                                         p_usage jsonb, p_error text, p_now timestamptz) returns bigint
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_over bigint := greatest(p_charge - r.bound_micro, 0); v_uncall int := (p_billing = 'none')::int;
        v_lotc bigint; v_release bigint;
begin
  if r.state <> 'calling' then raise exception 'moona: settle on % request %', r.state, r.id; end if;
  if p_charge is null or p_charge < 0 then raise exception 'moona: invalid charge'; end if;
  if r.mode = 'free' then
    perform moona._pool_settle(r.window_id, r.bound_micro, p_charge, v_over, v_uncall);
    if r.slice_id is not null then perform moona._pool_settle(r.slice_id, r.bound_micro, p_charge, v_over, v_uncall); end if;
    perform moona._pool_settle('ai', r.bound_micro, p_charge, v_over, v_uncall);
    update moona.subject_usage set reserved = reserved - 1, used = used + (p_state = 'succeeded')::int,
           failed = failed + (p_state <> 'succeeded' and p_charge > 0)::int
     where subject_key = r.subject_key and window_id = r.window_id and purpose = r.purpose;
  else
    v_lotc := least(p_charge, r.take_micro);
    v_release := v_lotc + r.extra_micro;                 -- lot allocation moves held->spent; the extra hold is released
    update moona.lots set alloc_held_micro = alloc_held_micro - r.take_micro,
           alloc_spent_micro = alloc_spent_micro + v_lotc where order_id = r.lot_id;
    perform moona._pool_settle('ai', v_release, p_charge, v_over, v_uncall);
    perform moona._pool_settle('packs', v_release, p_charge, v_over, 0);
    if r.mode = 'paid_reading' then
      update moona.lots set readings_reserved = readings_reserved - 1,
             readings_used = readings_used + (p_state = 'succeeded')::int where order_id = r.lot_id;
    else
      update moona.paid_readings set followups_reserved = followups_reserved - 1,
             followups_used = followups_used + (p_state = 'succeeded')::int where id = r.paid_reading_id;
    end if;
  end if;
  update moona.gate set inflight = inflight - 1, updated_at = p_now where id = 1;
  update moona.requests set state = p_state, charged_micro = p_charge, lot_charged_micro = v_lotc, billing = p_billing,
         usage = coalesce(p_usage, usage), error_code = p_error, finished_at = p_now where id = r.id;
  if v_over > 0 then
    update moona.gate g set breaker = 'tripped', breaker_reason = 'bound_overrun ' || r.id, updated_at = p_now
     where g.id = 1 and (select x.overrun_micro from moona.pools x where x.id = 'ai') - g.overrun_ack_micro
                        >= (select pl.overrun_trip_micro from moona.plan pl);
  end if;
  return v_over;
end $$;

create or replace function moona._maybe_close_lot(p_lot uuid, p_now timestamptz) returns void
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v moona.lots; v_left bigint;
begin
  select * into strict v from moona.lots where order_id = p_lot;
  if v.state not in ('open','revoking') then return; end if;
  if exists (select 1 from moona.requests where lot_id = p_lot and state = 'calling') then return; end if;
  if v.state = 'open' and (v.readings_used < v.readings_total or exists (
       select 1 from moona.paid_readings where lot_id = p_lot and followups_used < followups_total)) then return; end if;
  v_left := v.alloc_micro - v.alloc_spent_micro;       -- alloc_held is 0 when nothing is calling
  update moona.pools set held_micro = held_micro - v_left where id in ('ai','packs');
  update moona.lots set state = case v.state when 'revoking' then 'revoked' else 'closed' end, closed_at = p_now where order_id = p_lot;
end $$;

create or replace function moona._release_order(o moona.orders, p_state text, p_now timestamptz) returns void
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if o.holds then
    update moona.pools set held_micro = held_micro - o.alloc_micro where id in ('ai','packs');
    update moona.pools set held_micro = held_micro - o.fee_hold_micro where id = 'reserve';
  end if;
  update moona.orders set state = p_state, holds = false, closed_at = p_now where id = o.id;
end $$;

create or replace function moona._reap_locked(p_now timestamptz, p_limit int) returns int
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare r moona.requests; o moona.orders; n int := 0;
begin
  for r in select * from moona.requests where state = 'calling' and lease_expires_at <= p_now
           order by lease_expires_at limit p_limit loop
    perform moona._settle(r, 'expired', r.bound_micro, 'bound', null, 'lease_expired', p_now); -- money: bound; entitlement: released
    if r.mode <> 'free' then perform moona._maybe_close_lot(r.lot_id, p_now); end if;
    n := n + 1;
  end loop;
  -- only orders WITHOUT a checkout session may be released without asking the payment provider
  for o in select * from moona.orders where state = 'pending' and provider_session_id is null
           and created_at <= p_now - interval '10 minutes' order by created_at limit p_limit loop
    perform moona._release_order(o, 'canceled', p_now); n := n + 1;
  end loop;
  return n;
end $$;

-- RESERVE: free / paid reading / paid follow-up admission
create or replace function moona.reserve(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare
  v_now timestamptz := moona._clock(p); v_mode text := p->>'mode'; v_bound bigint := (p->>'bound_micro')::bigint;
  v_subject text := p->>'subject_key'; v_scope text := p->>'cache_scope'; v_purpose text := p->>'purpose';
  v_idem bytea := decode(p->>'idem_key','hex'); v_hash bytea := decode(p->>'input_hash','hex');
  v_acct uuid := nullif(p->>'account_id','')::uuid; v_exempt boolean := coalesce((p->>'quota_exempt')::boolean, false);
  g moona.gate; pl moona.plan; v_ai moona.pools; v_pk moona.pools; v_win moona.pools; v_sl moona.pools;
  v_q moona.free_quotas; v_u moona.subject_usage; v_has_u boolean; v_lot moona.lots; v_pr moona.paid_readings; v_r moona.requests;
  v_slice_id text; v_slice_start timestamptz; v_take bigint := 0; v_extra bigint := 0; v_free bigint;
  v_id uuid := gen_random_uuid(); v_lease timestamptz;
begin
  if v_bound is null or v_bound <= 0 then raise exception 'moona: invalid bound'; end if;
  if v_mode not in ('free','paid_reading','paid_followup') then raise exception 'moona: bad mode %', v_mode; end if;
  if v_mode <> 'free' and (v_acct is null or v_subject <> ('a:' || v_acct::text)) then raise exception 'moona: paid needs account subject'; end if;
  if v_mode = 'free' and left(v_subject, 2) <> 'v:' then raise exception 'moona: free needs visitor subject'; end if;
  perform moona._lock();
  select * into pl from moona.plan;
  if not found then return moona._deny('plan_unsynced'); end if;
  perform moona._reap_locked(v_now, 25);
  select * into g from moona.gate where id = 1;
  -- 1. idempotency (same subject + purpose + client request id)
  select * into v_r from moona.requests where idem_key = v_idem;
  if found then
    if v_r.input_hash <> v_hash or v_r.mode <> v_mode then return moona._deny('key_reused'); end if;
    return jsonb_build_object('status','existing','request', moona._view(v_r));
  end if;
  -- 2. free only: replay a saved result, or join an identical in-flight request
  if v_mode = 'free' then
    select * into v_r from moona.requests where cache_scope = v_scope and purpose = v_purpose and input_hash = v_hash
       and mode = 'free' and state = 'succeeded' and not result_purged and (result_expires_at is null or result_expires_at > v_now)
     order by finished_at desc limit 1;
    if found then return jsonb_build_object('status','cached','request', moona._view(v_r)); end if;
    select * into v_r from moona.requests where cache_scope = v_scope and purpose = v_purpose and input_hash = v_hash
       and mode = 'free' and state = 'calling';
    if found then return jsonb_build_object('status','in_progress','request_id', v_r.id); end if;
  end if;
  -- 3. global gates
  if g.breaker = 'tripped' then return moona._deny('paused'); end if;
  if g.cooldown_until is not null and g.cooldown_until > v_now then
    return moona._deny('cooldown') || jsonb_build_object('retry_after_s', ceil(extract(epoch from g.cooldown_until - v_now))::int);
  end if;
  if g.inflight >= pl.inflight_cap then return moona._deny('busy'); end if;
  if (select count(*) from moona.requests where subject_key = v_subject and state = 'calling') >= pl.subject_inflight_cap
    then return moona._deny('subject_busy'); end if;
  select * into strict v_ai from moona.pools where id = 'ai';
  if v_mode = 'free' then
    select * into v_win from moona.pools where kind = 'window' and starts_at <= v_now and v_now < ends_at order by starts_at desc limit 1;
    if not found then return moona._deny('no_window'); end if;
    if v_ai.spent_micro + v_ai.held_micro + v_bound > v_ai.cap_micro then return moona._deny('total_usd'); end if;
    if v_win.spent_micro + v_win.held_micro + v_bound > v_win.cap_micro then return moona._deny('window_usd'); end if;
    if v_win.calls_cap is not null and v_win.calls_used >= v_win.calls_cap then return moona._deny('window_calls'); end if;
    if v_win.slice_cap_micro is not null then
      v_slice_start := to_timestamp((floor(extract(epoch from v_now) / v_win.slice_seconds) * v_win.slice_seconds)::double precision);
      v_slice_id := 'slice:' || v_win.id || ':' || to_char(v_slice_start at time zone 'UTC', 'YYYYMMDD"T"HH24MI"Z"');
      insert into moona.pools (id, kind, parent_id, cap_micro, starts_at, ends_at)
      values (v_slice_id, 'slice', v_win.id, v_win.slice_cap_micro, v_slice_start, v_slice_start + make_interval(secs => v_win.slice_seconds))
      on conflict (id) do nothing;
      select * into strict v_sl from moona.pools where id = v_slice_id;
      if v_sl.spent_micro + v_sl.held_micro + v_bound > v_sl.cap_micro then return moona._deny('slice_usd'); end if;
    end if;
    select * into v_q from moona.free_quotas where window_id = v_win.id and purpose = v_purpose;
    if not found then return moona._deny('purpose_closed'); end if;
    select * into v_u from moona.subject_usage where subject_key = v_subject and window_id = v_win.id and purpose = v_purpose;
    v_has_u := found;
    if not v_exempt then
      if v_q.per_subject < 1 or (v_has_u and v_u.reserved + v_u.used >= v_q.per_subject) then return moona._deny('subject_quota'); end if;
      if v_has_u and v_u.failed >= v_q.failed_cap then return moona._deny('subject_failures'); end if;
    end if;
    insert into moona.subject_usage as u (subject_key, window_id, purpose, reserved) values (v_subject, v_win.id, v_purpose, 1)
    on conflict (subject_key, window_id, purpose) do update set reserved = u.reserved + 1;
    update moona.pools set held_micro = held_micro + v_bound, calls_used = calls_used + 1
     where id = v_win.id or id = 'ai' or id = v_slice_id;
  else
    select * into strict v_pk from moona.pools where id = 'packs';
    if v_mode = 'paid_reading' then
      select * into v_lot from moona.lots where account_id = v_acct and state = 'open'
         and readings_reserved + readings_used < readings_total order by created_at, order_id limit 1;
      if not found then return moona._deny('no_credits'); end if;
    else
      select * into v_pr from moona.paid_readings where id = nullif(p->>'paid_reading_id','')::uuid and account_id = v_acct;
      if not found then return moona._deny('no_such_reading'); end if;
      if v_pr.reading_hash <> decode(p->>'reading_hash','hex') then return moona._deny('reading_mismatch'); end if;
      if v_pr.followups_reserved + v_pr.followups_used >= v_pr.followups_total then return moona._deny('no_followups'); end if;
      select * into strict v_lot from moona.lots where order_id = v_pr.lot_id;
      if v_lot.state <> 'open' then return moona._deny('lot_closed'); end if;
    end if;
    v_free := v_lot.alloc_micro - v_lot.alloc_spent_micro - v_lot.alloc_held_micro;
    v_take := least(v_bound, greatest(v_free, 0));
    v_extra := v_bound - v_take;                                   -- shortfall comes from the pack pool's slack
    if v_extra > 0 and (v_pk.spent_micro + v_pk.held_micro + v_extra > v_pk.cap_micro
                        or v_ai.spent_micro + v_ai.held_micro + v_extra > v_ai.cap_micro) then
      update moona.gate set sales = 'closed', sales_reason = 'paid_capacity ' || v_lot.order_id, updated_at = v_now where id = 1;
      return moona._deny('paid_capacity');                         -- credit kept; operator reviews / refunds
    end if;
    if v_mode = 'paid_reading' then
      update moona.lots set readings_reserved = readings_reserved + 1, alloc_held_micro = alloc_held_micro + v_take where order_id = v_lot.order_id;
    else
      update moona.paid_readings set followups_reserved = followups_reserved + 1 where id = v_pr.id;
      update moona.lots set alloc_held_micro = alloc_held_micro + v_take where order_id = v_lot.order_id;
    end if;
    update moona.pools set held_micro = held_micro + v_extra where id = 'packs';
    update moona.pools set held_micro = held_micro + v_extra, calls_used = calls_used + 1 where id = 'ai';
  end if;
  update moona.gate set inflight = inflight + 1, updated_at = v_now where id = 1;
  v_lease := v_now + make_interval(secs => pl.lease_seconds);
  insert into moona.requests (id, idem_key, subject_key, account_id, cache_scope, purpose, mode, input_hash, window_id, slice_id,
      lot_id, paid_reading_id, bound_micro, take_micro, extra_micro, state, lease_expires_at, created_at)
  values (v_id, v_idem, v_subject, v_acct, v_scope, v_purpose, v_mode, v_hash, v_win.id, v_slice_id,
      v_lot.order_id, v_pr.id, v_bound, v_take, v_extra, 'calling', v_lease, v_now);
  return jsonb_build_object('status','reserved','request_id', v_id, 'lease_expires_at', v_lease);
end $$;

-- COMPLETE: save the validated result + settle money + consume the entitlement, in one statement
create or replace function moona.complete(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); v_charge bigint := (p->>'charged_micro')::bigint;
        v_ttl int := (p->>'result_ttl_seconds')::int; r moona.requests; v_over bigint; v_ratio numeric;
begin
  perform moona._lock();
  select * into r from moona.requests where id = (p->>'request_id')::uuid;
  if not found then raise exception 'moona: unknown request'; end if;
  if r.state = 'succeeded' then return jsonb_build_object('status','already','request', moona._view(r)); end if;
  if r.state = 'failed' then return jsonb_build_object('status','conflict'); end if;
  if r.state = 'expired' then           -- late: bound already charged, entitlement already released; keep the text for replay only
    update moona.requests set result = coalesce(result, p->'result'), usage = coalesce(usage, p->'usage'),
           result_expires_at = coalesce(result_expires_at, v_now + make_interval(secs => v_ttl)) where id = r.id;
    return jsonb_build_object('status','late');
  end if;
  if v_charge is null or v_charge < 0 or p->'result' is null or p->>'billing' not in ('known','bound') or v_ttl is null
    then raise exception 'moona: invalid completion'; end if;
  update moona.requests set result = p->'result', result_expires_at = v_now + make_interval(secs => v_ttl) where id = r.id;
  if r.mode = 'paid_reading' then
    insert into moona.paid_readings (lot_id, account_id, request_id, reading_hash, followups_total, created_at)
    select r.lot_id, r.account_id, r.id, decode(p->>'reading_hash','hex'), l.followups_per_reading, v_now
      from moona.lots l where l.order_id = r.lot_id;
  end if;
  v_over := moona._settle(r, 'succeeded', v_charge, p->>'billing', p->'usage', null, v_now);
  update moona.gate set unknown_streak = 0 where id = 1;
  if r.mode <> 'free' then perform moona._maybe_close_lot(r.lot_id, v_now); end if;
  select max((x.spent_micro + x.held_micro)::numeric / nullif(x.cap_micro, 0)) into v_ratio
    from moona.pools x where x.id in ('ai', coalesce(r.window_id, 'ai'), coalesce(r.slice_id, 'ai'));
  select * into r from moona.requests where id = r.id;
  return jsonb_build_object('status','succeeded','request', moona._view(r), 'overrun_micro', v_over, 'budget_ratio', v_ratio);
end $$;

-- FAIL: settle by billing certainty and RELEASE the entitlement / quota slot
create or replace function moona.fail(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); v_billing text := p->>'billing'; r moona.requests; pl moona.plan;
        v_charge bigint; v_over bigint; v_rl boolean := coalesce((p->>'rate_limited')::boolean, false);
        v_retry int := coalesce((p->>'retry_after_s')::int, 0);
begin
  perform moona._lock();
  select * into strict pl from moona.plan;
  select * into r from moona.requests where id = (p->>'request_id')::uuid;
  if not found then raise exception 'moona: unknown request'; end if;
  if r.state <> 'calling' then return jsonb_build_object('status', case r.state when 'expired' then 'late' else 'already' end); end if;
  v_charge := case v_billing when 'none' then 0 when 'unknown' then r.bound_micro when 'bound' then r.bound_micro
                             when 'known' then (p->>'charged_micro')::bigint end;
  v_over := moona._settle(r, 'failed', v_charge, v_billing, p->'usage', p->>'error_code', v_now);
  if v_billing = 'unknown' then
    update moona.gate set unknown_streak = unknown_streak + 1,
           cooldown_until = case when unknown_streak + 1 >= pl.unknown_trip
             then greatest(coalesce(cooldown_until, v_now), v_now + make_interval(secs => pl.unknown_cooldown_s)) else cooldown_until end
     where id = 1;
  else
    update moona.gate set unknown_streak = 0 where id = 1;
  end if;
  if v_rl then
    update moona.gate set
      rl_hits = case when rl_window_start is null or rl_window_start <= v_now - make_interval(secs => pl.rl_window_s) then 1 else rl_hits + 1 end,
      rl_window_start = case when rl_window_start is null or rl_window_start <= v_now - make_interval(secs => pl.rl_window_s) then v_now else rl_window_start end
     where id = 1;
    update moona.gate set cooldown_until = greatest(coalesce(cooldown_until, v_now), v_now + make_interval(secs => greatest(pl.rl_cooldown_s, v_retry))),
           rl_hits = 0, rl_window_start = null
     where id = 1 and rl_hits >= pl.rl_trip;
  end if;
  if r.mode <> 'free' then perform moona._maybe_close_lot(r.lot_id, v_now); end if;
  return jsonb_build_object('status','failed','charged_micro', v_charge, 'overrun_micro', v_over);
end $$;

create or replace function moona.mint_visitor(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); pl moona.plan; v_win moona.pools; v_ws timestamptz; v_n int;
begin
  perform moona._lock();
  select * into pl from moona.plan;
  if not found then return moona._deny('plan_unsynced'); end if;
  select * into v_win from moona.pools where kind = 'window' and starts_at <= v_now and v_now < ends_at order by starts_at desc limit 1;
  if found and v_win.mint_cap is not null and v_win.minted >= v_win.mint_cap then return moona._deny('mint_cap'); end if;
  v_ws := to_timestamp((floor(extract(epoch from v_now) / pl.mint_net_window_s) * pl.mint_net_window_s)::double precision);
  insert into moona.rate_windows as w (key, window_start, count) values ('mint:' || (p->>'net_bucket'), v_ws, 1)
  on conflict (key, window_start) do update set count = w.count + 1 where w.count < pl.mint_net_limit
  returning count into v_n;
  if v_n is null then return moona._deny('mint_net'); end if;
  update moona.pools set minted = minted + 1 where id = v_win.id;
  return jsonb_build_object('status','ok');
end $$;

create or replace function moona.ensure_account(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid;
begin
  insert into moona.accounts (provider, subject, created_at) values (p->>'provider', p->>'subject', moona._clock(p))
  on conflict (provider, subject) do nothing returning id into v_id;
  if v_id is null then select id into strict v_id from moona.accounts where provider = p->>'provider' and subject = p->>'subject'; end if;
  return jsonb_build_object('account_id', v_id);
end $$;

-- CREATE ORDER: hold fulfilment (ai + packs) and the fee estimate (reserve) BEFORE any redirect
create or replace function moona.create_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); v_acct uuid := (p->>'account_id')::uuid; v_mode text := p->>'mode';
        g moona.gate; pl moona.plan; v_ai moona.pools; v_pk moona.pools; v_res moona.pools; v_p moona.products; o moona.orders; v_sold int;
begin
  if v_mode not in ('fake','test','live') then raise exception 'moona: bad mode'; end if;
  perform moona._lock();
  select * into pl from moona.plan;
  if not found then return moona._deny('plan_unsynced'); end if;
  perform moona._reap_locked(v_now, 25);
  select * into g from moona.gate where id = 1;
  select * into o from moona.orders where account_id = v_acct and checkout_key = p->>'checkout_key';
  if found then return jsonb_build_object('status','existing','order', moona._order_view(o)); end if;
  select * into o from moona.orders where account_id = v_acct and state = 'pending';
  if found then return jsonb_build_object('status','pending_exists','order', moona._order_view(o)); end if;
  if g.breaker = 'tripped' or g.sales = 'closed' then return moona._deny('sales_closed'); end if;
  select * into v_p from moona.products where id = p->>'product_id' and active;
  if not found then return moona._deny('no_product'); end if;
  select count(*) into v_sold from moona.orders where product_id = v_p.id and (mode = 'live') = (v_mode = 'live')
     and state in ('pending','paid','paid_unfunded','needs_review');
  if v_sold >= case when v_mode = 'live' then v_p.max_sold_live else v_p.max_sold_test end then return moona._deny('sold_out'); end if;
  select * into strict v_ai from moona.pools where id = 'ai';
  select * into strict v_pk from moona.pools where id = 'packs';
  select * into strict v_res from moona.pools where id = 'reserve';
  if v_pk.spent_micro + v_pk.held_micro + v_p.alloc_micro + pl.pack_slack_micro > v_pk.cap_micro
     or v_ai.spent_micro + v_ai.held_micro + v_p.alloc_micro > v_ai.cap_micro
     or v_res.spent_micro + v_res.held_micro + v_p.fee_hold_micro > v_res.cap_micro then return moona._deny('budget_short'); end if;
  update moona.pools set held_micro = held_micro + v_p.alloc_micro where id in ('ai','packs');
  update moona.pools set held_micro = held_micro + v_p.fee_hold_micro where id = 'reserve';
  insert into moona.orders (account_id, product_id, mode, state, holds, amount_cents, currency, readings, followups_per_reading,
                            alloc_micro, fee_hold_micro, checkout_key, checkout_expires_at, created_at)
  values (v_acct, v_p.id, v_mode, 'pending', true, v_p.amount_cents, v_p.currency, v_p.readings, v_p.followups_per_reading,
          v_p.alloc_micro, v_p.fee_hold_micro, p->>'checkout_key', v_now + make_interval(secs => pl.checkout_ttl_s), v_now)
  returning * into o;
  return jsonb_build_object('status','created','order', moona._order_view(o));
end $$;

create or replace function moona.attach_session(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare o moona.orders;
begin
  perform moona._lock();
  select * into o from moona.orders where id = (p->>'order_id')::uuid;
  if not found then return jsonb_build_object('status','not_pending'); end if;
  if o.provider_session_id = p->>'session_id' then return jsonb_build_object('status','attached'); end if;
  if o.state <> 'pending' or o.provider_session_id is not null then return jsonb_build_object('status','not_pending'); end if;
  update moona.orders set provider_session_id = p->>'session_id', checkout_url = p->>'url' where id = o.id;
  return jsonb_build_object('status','attached');
end $$;

-- FULFIL: verified webhook or verified sync -> grant exactly once
create or replace function moona.fulfil(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); v_ev text := p->>'event_id'; v_ai moona.pools; v_pk moona.pools; v_res moona.pools;
        o moona.orders; v_n int;
begin
  perform moona._lock();
  insert into moona.payment_events (event_id, type, order_id, outcome, received_at)
  values (v_ev, p->>'type', nullif(p->>'order_id','')::uuid, 'processing', v_now) on conflict (event_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('status','duplicate_event'); end if;
  select * into o from moona.orders where id = nullif(p->>'order_id','')::uuid;
  if not found then return moona._event(v_ev, 'unknown_order'); end if;
  if o.provider_session_id is distinct from p->>'session_id' then return moona._event(v_ev, 'session_mismatch'); end if;
  if (o.mode = 'live') is distinct from (p->>'livemode')::boolean then return moona._event(v_ev, 'mode_mismatch'); end if;
  if not coalesce((p->>'paid')::boolean, false) then return moona._event(v_ev, 'not_paid'); end if;
  if o.state in ('paid','paid_unfunded','needs_review','revoked') then return moona._event(v_ev, 'already'); end if;
  if o.amount_cents is distinct from (p->>'amount_cents')::int or o.currency is distinct from lower(p->>'currency') then
    update moona.orders set state = 'needs_review', review_note = 'amount_mismatch', paid_at = v_now,
           provider_payment_id = nullif(p->>'payment_id','') where id = o.id;     -- holds stay until an operator refunds
    update moona.gate set sales = 'closed', sales_reason = 'amount_mismatch ' || o.id, updated_at = v_now where id = 1;
    return moona._event(v_ev, 'amount_mismatch');
  end if;
  if not o.holds then                                   -- paid after expiry/cancel: re-acquire under the same caps
    select * into strict v_ai from moona.pools where id = 'ai';
    select * into strict v_pk from moona.pools where id = 'packs';
    select * into strict v_res from moona.pools where id = 'reserve';
    if v_pk.spent_micro + v_pk.held_micro + o.alloc_micro > v_pk.cap_micro
       or v_ai.spent_micro + v_ai.held_micro + o.alloc_micro > v_ai.cap_micro
       or v_res.spent_micro + v_res.held_micro + o.fee_hold_micro > v_res.cap_micro then
      update moona.orders set state = 'paid_unfunded', paid_at = v_now, provider_payment_id = nullif(p->>'payment_id','') where id = o.id;
      update moona.gate set sales = 'closed', sales_reason = 'paid_unfunded ' || o.id, updated_at = v_now where id = 1;
      return moona._event(v_ev, 'paid_unfunded');       -- nothing granted; the cap holds; operator refunds
    end if;
    update moona.pools set held_micro = held_micro + o.alloc_micro where id in ('ai','packs');
    update moona.pools set held_micro = held_micro + o.fee_hold_micro where id = 'reserve';
  end if;
  update moona.pools set held_micro = held_micro - o.fee_hold_micro, spent_micro = spent_micro + o.fee_hold_micro where id = 'reserve';
  insert into moona.entries (entry_id, pool_id, kind, amount_micro, order_id, note, created_at)
  values ('fee:' || o.id, 'reserve', 'fee_estimate', o.fee_hold_micro, o.id, 'payment fee estimate', v_now);
  update moona.orders set state = 'paid', holds = false, paid_at = v_now, closed_at = null,
         provider_payment_id = nullif(p->>'payment_id','') where id = o.id;
  insert into moona.lots (order_id, account_id, mode, state, readings_total, followups_per_reading, alloc_micro, created_at)
  values (o.id, o.account_id, o.mode, 'open', o.readings, o.followups_per_reading, o.alloc_micro, v_now);   -- order hold becomes lot allocation
  return moona._event(v_ev, 'granted');
end $$;

create or replace function moona.expire_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); o moona.orders; v_n int; v_kind text := coalesce(p->>'kind','expired');
begin
  perform moona._lock();
  insert into moona.payment_events (event_id, type, outcome, received_at) values (p->>'event_id', v_kind, 'processing', v_now)
  on conflict (event_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('status','duplicate_event'); end if;
  select * into o from moona.orders where provider_session_id = p->>'session_id';
  if not found then return moona._event(p->>'event_id', 'unknown_session'); end if;
  update moona.payment_events set order_id = o.id where event_id = p->>'event_id';
  if o.state <> 'pending' then return moona._event(p->>'event_id', 'noop'); end if;
  perform moona._release_order(o, case v_kind when 'async_failed' then 'canceled' else 'expired' end, v_now);
  return moona._event(p->>'event_id', 'released');
end $$;

create or replace function moona.revoke_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); o moona.orders; v_n int; v_kind text := p->>'kind';
begin
  if v_kind not in ('refund_full','refund_partial','dispute') then raise exception 'moona: bad revoke kind'; end if;
  perform moona._lock();
  insert into moona.payment_events (event_id, type, outcome, received_at) values (p->>'event_id', v_kind, 'processing', v_now)
  on conflict (event_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('status','duplicate_event'); end if;
  select * into o from moona.orders
   where provider_payment_id = nullif(p->>'payment_id','') or id = nullif(p->>'order_id','')::uuid
   order by (provider_payment_id = nullif(p->>'payment_id','')) desc nulls last limit 1;
  if not found then return moona._event(p->>'event_id', 'unknown_payment'); end if;
  update moona.payment_events set order_id = o.id where event_id = p->>'event_id';
  if v_kind = 'refund_partial' then
    update moona.orders set review_note = 'partial_refund' where id = o.id;
    return moona._event(p->>'event_id', 'partial_refund_review');
  end if;
  if o.state = 'revoked' then return moona._event(p->>'event_id', 'already'); end if;
  if o.holds then perform moona._release_order(o, 'revoked', v_now);
  else update moona.orders set state = 'revoked', closed_at = v_now where id = o.id; end if;
  update moona.lots set state = 'revoking' where order_id = o.id and state = 'open';
  if exists (select 1 from moona.lots where order_id = o.id) then perform moona._maybe_close_lot(o.id, v_now); end if;
  return moona._event(p->>'event_id', 'revoked');      -- in-flight paid requests finish; the leftover is released after the last one
end $$;

create or replace function moona.revoke_mode(p jsonb) returns jsonb    -- go-live: release/revoke all fake+test packs (owner only)
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); o moona.orders; n int := 0;
begin
  perform moona._lock();
  for o in select * from moona.orders where mode <> 'live' and state in ('pending','paid','paid_unfunded','needs_review') loop
    if o.state = 'pending' then perform moona._release_order(o, 'canceled', v_now);
    elsif o.holds then perform moona._release_order(o, 'revoked', v_now);
    else update moona.orders set state = 'revoked', closed_at = v_now where id = o.id; end if;
    update moona.lots set state = 'revoking' where order_id = o.id and state = 'open';
    if exists (select 1 from moona.lots where order_id = o.id) then perform moona._maybe_close_lot(o.id, v_now); end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('status','ok','orders', n);
end $$;

create or replace function moona.reap(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); n int;
begin
  perform moona._lock();
  n := moona._reap_locked(v_now, coalesce((p->>'limit')::int, 200));
  delete from moona.rate_windows where window_start < v_now - interval '1 day';
  return jsonb_build_object('status','ok','reaped', n);
end $$;

create or replace function moona.purge_results(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); n int;
begin
  perform moona._lock();
  update moona.requests set result = null, result_purged = true
   where result is not null and not result_purged and result_expires_at <= v_now;
  get diagnostics n = row_count;
  return jsonb_build_object('status','ok','purged', n);
end $$;

create or replace function moona.set_flag(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p);
begin
  perform moona._lock();
  if p->>'key' = 'breaker' and p->>'value' in ('ok','tripped') then
    update moona.gate set breaker = p->>'value', breaker_reason = p->>'reason', updated_at = v_now,
           overrun_ack_micro = case when p->>'value' = 'ok' then (select overrun_micro from moona.pools where id = 'ai') else overrun_ack_micro end
     where id = 1;
  elsif p->>'key' = 'sales' and p->>'value' in ('open','closed') then
    update moona.gate set sales = p->>'value', sales_reason = p->>'reason', updated_at = v_now where id = 1;
  else raise exception 'moona: bad flag'; end if;
  return jsonb_build_object('status','ok');
end $$;

create or replace function moona.record_spend(p jsonb) returns jsonb           -- owner only (script)
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); v_pool text; v_amt bigint := (p->>'amount_micro')::bigint; v_n int; v_done int := 0;
begin
  perform moona._lock();
  for v_pool in select jsonb_array_elements_text(p->'pools') loop
    insert into moona.entries (entry_id, pool_id, kind, amount_micro, order_id, note, created_at)
    values (p->>'entry_id', v_pool, p->>'kind', v_amt, nullif(p->>'order_id','')::uuid, coalesce(p->>'note',''), v_now)
    on conflict (entry_id, pool_id) do nothing;
    get diagnostics v_n = row_count;
    if v_n = 1 then
      update moona.pools set spent_micro = spent_micro + v_amt,
             overrun_micro = overrun_micro + greatest(spent_micro + v_amt + held_micro - cap_micro - overrun_micro, 0)
       where id = v_pool;
      v_done := v_done + 1;
    end if;
  end loop;
  return jsonb_build_object('status', case when v_done = 0 then 'duplicate' else 'recorded' end);
end $$;

-- SYNC PLAN (owner only; never touches spent/held/overrun/calls_used/minted)
create or replace function moona.sync_plan(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp set lock_timeout = '2s' as $$
declare v_now timestamptz := moona._clock(p); pl jsonb := p->'plan'; x jsonb; v_ids text[]; v_bad text; v_n int;
begin
  perform moona._lock();
  v_ids := array(select e->>'id' from jsonb_array_elements(p->'pools') e);
  if not (v_ids @> array['ai','packs','hosting','reserve']) then raise exception 'moona: plan lacks base pools'; end if;
  for x in select * from jsonb_array_elements(p->'pools') loop
    insert into moona.pools as t (id, kind, cap_micro, calls_cap, slice_cap_micro, slice_seconds, mint_cap, starts_at, ends_at)
    values (x->>'id', x->>'kind', (x->>'cap_micro')::bigint, (x->>'calls_cap')::int, (x->>'slice_cap_micro')::bigint,
            (x->>'slice_seconds')::int, (x->>'mint_cap')::int, (x->>'starts_at')::timestamptz, (x->>'ends_at')::timestamptz)
    on conflict (id) do update set cap_micro = excluded.cap_micro, calls_cap = excluded.calls_cap, slice_cap_micro = excluded.slice_cap_micro,
       slice_seconds = excluded.slice_seconds, mint_cap = excluded.mint_cap, starts_at = excluded.starts_at, ends_at = excluded.ends_at
     where t.kind = excluded.kind;
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'moona: pool % would change kind', x->>'id'; end if;
  end loop;
  delete from moona.free_quotas q using moona.pools w
   where q.window_id = w.id and w.kind = 'window' and w.starts_at > v_now and not (w.id = any (v_ids));
  delete from moona.pools w where w.kind = 'window' and w.starts_at > v_now and not (w.id = any (v_ids));
  update moona.pools set ends_at = v_now where kind = 'window' and starts_at < v_now and ends_at > v_now and not (id = any (v_ids));
  update moona.pools s set cap_micro = w.slice_cap_micro from moona.pools w
   where s.kind = 'slice' and s.parent_id = w.id and s.ends_at > v_now and w.slice_cap_micro is not null;
  select a.id || ' / ' || b.id into v_bad from moona.pools a join moona.pools b on a.id < b.id
   where a.kind = 'window' and b.kind = 'window' and a.starts_at < b.ends_at and b.starts_at < a.ends_at limit 1;
  if v_bad is not null then raise exception 'moona: windows overlap: %', v_bad; end if;
  select id into v_bad from moona.pools where kind <> 'slice' and spent_micro + held_micro > cap_micro + overrun_micro limit 1;
  if v_bad is not null then raise exception 'moona: cap of % is below spent + held', v_bad; end if;
  if (select coalesce(sum(case when ends_at > v_now then cap_micro else spent_micro + held_micro end), 0) from moona.pools where kind = 'window')
     + (select cap_micro from moona.pools where id = 'packs') > (select cap_micro from moona.pools where id = 'ai')
    then raise exception 'moona: free windows + pack pool exceed the ai cap'; end if;
  if (select sum(cap_micro) from moona.pools where id in ('ai','hosting','reserve')) > (pl->>'cash_total_micro')::bigint
    then raise exception 'moona: ai + hosting + reserve exceed the cash total'; end if;
  delete from moona.free_quotas where window_id = any (v_ids);
  insert into moona.free_quotas (window_id, purpose, per_subject, failed_cap)
  select q->>'window_id', q->>'purpose', (q->>'per_subject')::int, (q->>'failed_cap')::int from jsonb_array_elements(p->'quotas') q;
  for x in select * from jsonb_array_elements(p->'products') loop
    insert into moona.products as t (id, active, amount_cents, currency, readings, followups_per_reading, alloc_micro, fee_hold_micro, max_sold_test, max_sold_live)
    values (x->>'id', (x->>'active')::boolean, (x->>'amount_cents')::int, x->>'currency', (x->>'readings')::int, (x->>'followups_per_reading')::int,
            (x->>'alloc_micro')::bigint, (x->>'fee_hold_micro')::bigint, (x->>'max_sold_test')::int, (x->>'max_sold_live')::int)
    on conflict (id) do update set active = excluded.active, amount_cents = excluded.amount_cents, currency = excluded.currency,
       readings = excluded.readings, followups_per_reading = excluded.followups_per_reading, alloc_micro = excluded.alloc_micro,
       fee_hold_micro = excluded.fee_hold_micro, max_sold_test = excluded.max_sold_test, max_sold_live = excluded.max_sold_live;
  end loop;
  update moona.products set active = false where not (id = any (array(select e->>'id' from jsonb_array_elements(p->'products') e)));
  insert into moona.plan as t (id, plan_id, plan_hash, cash_total_micro, overrun_trip_micro, inflight_cap, subject_inflight_cap, lease_seconds,
      unknown_trip, unknown_cooldown_s, rl_trip, rl_window_s, rl_cooldown_s, mint_net_limit, mint_net_window_s, checkout_ttl_s, pack_slack_micro, synced_at)
  values (true, pl->>'plan_id', pl->>'plan_hash', (pl->>'cash_total_micro')::bigint, (pl->>'overrun_trip_micro')::bigint,
      (pl->>'inflight_cap')::int, (pl->>'subject_inflight_cap')::int, (pl->>'lease_seconds')::int, (pl->>'unknown_trip')::int,
      (pl->>'unknown_cooldown_s')::int, (pl->>'rl_trip')::int, (pl->>'rl_window_s')::int, (pl->>'rl_cooldown_s')::int,
      (pl->>'mint_net_limit')::int, (pl->>'mint_net_window_s')::int, (pl->>'checkout_ttl_s')::int, (pl->>'pack_slack_micro')::bigint, v_now)
  on conflict (id) do update set plan_id = excluded.plan_id, plan_hash = excluded.plan_hash, cash_total_micro = excluded.cash_total_micro,
      overrun_trip_micro = excluded.overrun_trip_micro, inflight_cap = excluded.inflight_cap, subject_inflight_cap = excluded.subject_inflight_cap,
      lease_seconds = excluded.lease_seconds, unknown_trip = excluded.unknown_trip, unknown_cooldown_s = excluded.unknown_cooldown_s,
      rl_trip = excluded.rl_trip, rl_window_s = excluded.rl_window_s, rl_cooldown_s = excluded.rl_cooldown_s,
      mint_net_limit = excluded.mint_net_limit, mint_net_window_s = excluded.mint_net_window_s,
      checkout_ttl_s = excluded.checkout_ttl_s, pack_slack_micro = excluded.pack_slack_micro, synced_at = excluded.synced_at;
  return jsonb_build_object('status','synced','plan_hash', pl->>'plan_hash');
end $$;

-- Read-only views (no locks)
create or replace function moona.view_order(p jsonb) returns jsonb language sql security definer set search_path = pg_catalog, pg_temp as $$
  select moona._order_view(o) from moona.orders o where o.id = (p->>'order_id')::uuid and o.account_id = (p->>'account_id')::uuid $$;

create or replace function moona.orders_to_verify(p jsonb) returns jsonb language sql security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(v), '[]'::jsonb) from (
    select moona._order_view(o) v from moona.orders o
     where o.state = 'pending' and o.provider_session_id is not null and o.created_at <= moona._clock(p) - interval '2 minutes'
     order by o.created_at limit coalesce((p->>'limit')::int, 50)) t $$;

create or replace function moona.entitlements(p jsonb) returns jsonb language sql security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'credits', coalesce((select sum(readings_total - readings_used - readings_reserved) from moona.lots
                          where account_id = (p->>'account_id')::uuid and state = 'open'), 0),
    'readings', coalesce((select jsonb_agg(jsonb_build_object('paid_reading_id', x.id,
                  'followups_left', x.followups_total - x.followups_used - x.followups_reserved, 'lot_open', l.state = 'open') order by x.created_at)
                  from moona.paid_readings x join moona.lots l on l.order_id = x.lot_id where x.account_id = (p->>'account_id')::uuid), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(v order by c desc) from (select moona._order_view(o) v, o.created_at c from moona.orders o
                  where o.account_id = (p->>'account_id')::uuid order by o.created_at desc limit 20) t), '[]'::jsonb),
    'unservable', exists (select 1 from moona.lots l where l.account_id = (p->>'account_id')::uuid and l.state = 'open'
                  and l.alloc_micro - l.alloc_spent_micro - l.alloc_held_micro <= 0)) $$;

create or replace function moona.snapshot(p jsonb) returns jsonb language sql security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'plan', (select jsonb_build_object('plan_id', plan_id, 'plan_hash', plan_hash) from moona.plan),
    'gate', (select to_jsonb(g) from moona.gate g),
    'pools', (select jsonb_agg(to_jsonb(x) order by x.id) from moona.pools x where x.kind <> 'slice' or x.ends_at > moona._clock(p) - interval '1 day'),
    'active_window', (select id from moona.pools where kind = 'window' and starts_at <= moona._clock(p) and moona._clock(p) < ends_at order by starts_at desc limit 1),
    'sold', jsonb_build_object(
       'test', (select count(*) from moona.orders where mode <> 'live' and state in ('pending','paid','paid_unfunded','needs_review')),
       'live', (select count(*) from moona.orders where mode = 'live' and state in ('pending','paid','paid_unfunded','needs_review'))),
    'owed_readings', (select coalesce(sum(readings_total - readings_used - readings_reserved), 0) from moona.lots where state = 'open'),
    'review_orders', (select count(*) from moona.orders where state in ('paid_unfunded','needs_review') or review_note is not null)) $$;

-- AUDIT: recompute every counter from detail rows; '[]' means consistent
create or replace function moona.audit(p jsonb) returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
with fr as (select * from moona.requests where mode = 'free'), pr as (select * from moona.requests where mode <> 'free'),
v(check_name, subject, expected, actual) as (
  select 'pool_held', w.id, (select coalesce(sum(fr.bound_micro),0) from fr where fr.state = 'calling' and (fr.window_id = w.id or fr.slice_id = w.id))::numeric, w.held_micro::numeric
    from moona.pools w where w.kind in ('window','slice')
  union all select 'pool_spent', w.id, (select coalesce(sum(fr.charged_micro),0) from fr where fr.window_id = w.id or fr.slice_id = w.id)
      + (select coalesce(sum(e.amount_micro),0) from moona.entries e where e.pool_id = w.id), w.spent_micro from moona.pools w where w.kind in ('window','slice')
  union all select 'pool_calls', w.id, (select count(*) from fr where (fr.window_id = w.id or fr.slice_id = w.id) and fr.billing is distinct from 'none'), w.calls_used
    from moona.pools w where w.kind in ('window','slice')
  union all select 'held', x.id,
      (case when x.id = 'ai' then (select coalesce(sum(fr.bound_micro),0) from fr where fr.state = 'calling') else 0 end)
    + (select coalesce(sum(pr.extra_micro),0) from pr where pr.state = 'calling')
    + (select coalesce(sum(l.alloc_micro - l.alloc_spent_micro),0) from moona.lots l where l.state in ('open','revoking'))
    + (select coalesce(sum(o.alloc_micro),0) from moona.orders o where o.holds), x.held_micro from moona.pools x where x.id in ('ai','packs')
  union all select 'spent', x.id, (select coalesce(sum(r.charged_micro),0) from moona.requests r where x.id = 'ai' or r.mode <> 'free')
    + (select coalesce(sum(e.amount_micro),0) from moona.entries e where e.pool_id = x.id), x.spent_micro from moona.pools x where x.id in ('ai','packs')
  union all select 'ai_calls', 'ai', (select count(*) from moona.requests r where r.billing is distinct from 'none'), x.calls_used from moona.pools x where x.id = 'ai'
  union all select 'inflight', 'gate', (select count(*) from moona.requests r where r.state = 'calling'), g.inflight from moona.gate g
  union all select 'reserve_held', 'reserve', (select coalesce(sum(o.fee_hold_micro),0) from moona.orders o where o.holds), x.held_micro from moona.pools x where x.id = 'reserve'
  union all select 'entry_spent', x.id, (select coalesce(sum(e.amount_micro),0) from moona.entries e where e.pool_id = x.id), x.spent_micro
    from moona.pools x where x.kind in ('reserve','hosting')
  union all select 'cap', x.id, x.cap_micro + x.overrun_micro, x.spent_micro + x.held_micro from moona.pools x where x.spent_micro + x.held_micro > x.cap_micro + x.overrun_micro
  union all select 'lot_reserved', l.order_id::text, (select count(*) from pr where pr.lot_id = l.order_id and pr.mode = 'paid_reading' and pr.state = 'calling'), l.readings_reserved from moona.lots l
  union all select 'lot_used', l.order_id::text, (select count(*) from pr where pr.lot_id = l.order_id and pr.mode = 'paid_reading' and pr.state = 'succeeded'), l.readings_used from moona.lots l
  union all select 'lot_paid_readings', l.order_id::text, l.readings_used, (select count(*) from moona.paid_readings x where x.lot_id = l.order_id) from moona.lots l
  union all select 'lot_alloc_held', l.order_id::text, (select coalesce(sum(pr.take_micro),0) from pr where pr.lot_id = l.order_id and pr.state = 'calling'), l.alloc_held_micro from moona.lots l
  union all select 'lot_alloc_spent', l.order_id::text, (select coalesce(sum(pr.lot_charged_micro),0) from pr where pr.lot_id = l.order_id and pr.state <> 'calling'), l.alloc_spent_micro from moona.lots l
  union all select 'followups_reserved', x.id::text, (select count(*) from pr where pr.paid_reading_id = x.id and pr.state = 'calling'), x.followups_reserved from moona.paid_readings x
  union all select 'followups_used', x.id::text, (select count(*) from pr where pr.paid_reading_id = x.id and pr.state = 'succeeded'), x.followups_used from moona.paid_readings x
  union all select 'subject_reserved', u.subject_key||'/'||u.window_id||'/'||u.purpose, (select count(*) from fr where fr.state = 'calling' and fr.subject_key = u.subject_key and fr.window_id = u.window_id and fr.purpose = u.purpose), u.reserved from moona.subject_usage u
  union all select 'subject_used', u.subject_key||'/'||u.window_id||'/'||u.purpose, (select count(*) from fr where fr.state = 'succeeded' and fr.subject_key = u.subject_key and fr.window_id = u.window_id and fr.purpose = u.purpose), u.used from moona.subject_usage u
  union all select 'subject_failed', u.subject_key||'/'||u.window_id||'/'||u.purpose, (select count(*) from fr where fr.state in ('failed','expired') and fr.charged_micro > 0 and fr.subject_key = u.subject_key and fr.window_id = u.window_id and fr.purpose = u.purpose), u.failed from moona.subject_usage u
  union all select 'lot_has_paid_order', l.order_id::text, 1, (select count(*) from moona.orders o where o.id = l.order_id and o.state in ('paid','revoked')) from moona.lots l
  union all select 'paid_order_has_lot', o.id::text, 1, (select count(*) from moona.lots l where l.order_id = o.id) from moona.orders o where o.state = 'paid'
  union all select 'fee_entry', o.id::text, o.fee_hold_micro, (select coalesce(sum(e.amount_micro),0) from moona.entries e where e.order_id = o.id and e.kind = 'fee_estimate')
    from moona.orders o where exists (select 1 from moona.lots l where l.order_id = o.id))
select coalesce(jsonb_agg(jsonb_build_object('check', check_name, 'subject', subject, 'expected', expected, 'actual', actual) order by check_name, subject), '[]'::jsonb)
  from v where expected is distinct from actual $$;
```

### 4.3 `003_roles.sql` (real Postgres only) and `900_test_clock.sql` (tests only)

```sql
-- 003_roles.sql
do $$ begin if not exists (select 1 from pg_roles where rolname = 'moona_app') then create role moona_app login; end if; end $$;
-- The user sets the password themselves: alter role moona_app password '...'; Vercel uses the moona_app pooler URL.
revoke all on schema moona from public;
grant usage on schema moona to moona_app;
revoke all on all tables in schema moona from public, moona_app;
revoke all on all sequences in schema moona from public, moona_app;
revoke all on all functions in schema moona from public;
grant execute on function moona.reserve(jsonb), moona.complete(jsonb), moona.fail(jsonb), moona.mint_visitor(jsonb),
  moona.ensure_account(jsonb), moona.entitlements(jsonb), moona.view_order(jsonb), moona.orders_to_verify(jsonb),
  moona.create_order(jsonb), moona.attach_session(jsonb), moona.fulfil(jsonb), moona.expire_order(jsonb), moona.revoke_order(jsonb),
  moona.reap(jsonb), moona.purge_results(jsonb), moona.snapshot(jsonb), moona.audit(jsonb), moona.set_flag(jsonb) to moona_app;
-- Owner only (ledger-admin script via DATABASE_OWNER_URL): sync_plan, record_spend, revoke_mode.
do $$ begin if exists (select 1 from pg_roles where rolname = 'anon') then
  revoke all on schema moona from anon, authenticated; end if; end $$;  -- Supabase: never add 'moona' to the Data API exposed schemas
```

```sql
-- 900_test_clock.sql: applied ONLY by migrate({ testClock: true }); never in production migrations
create or replace function moona._clock(p jsonb) returns timestamptz language sql volatile
set search_path = pg_catalog, pg_temp as $$ select coalesce((p->>'now')::timestamptz, clock_timestamp()) $$;
```

### 4.4 Invariants (asserted by `audit()` in every test) and proof sketch

Notation: S = spent + held for the pool in question (ai, packs, window or slice). b = request bound, c = charge, a = pack allocation, x = extra (shortfall hold), t = take.

| Operation | Effect on S | Precondition |
|---|---|---|
| Free admit | S' = S + b | S + b ≤ cap, on ai, the window and the slice |
| Free settle | S' = S − b + c ≤ S + overrun | |
| Paid admit | S' = S + x | S + x ≤ cap, on ai and packs |
| Paid settle | S' = S − (min(c,t) + x) + c ≤ S + overrun | |
| Order create | S' = S + a | S + a (+ slack on packs) ≤ cap |
| Expire, cancel or revoke | S' = S − a | |
| Fulfil, normal | S unchanged | |
| Fulfil, late payment | S' = S + a | Cap rechecked; otherwise `paid_unfunded` and nothing is granted |
| Lot close | S' = S − leftover | |
| Reap | Settles at c = b, so S is unchanged | |

**Consequences**
- **Cap bound.** By induction, S ≤ cap + overrun for every pool. The breaker trips once cumulative ai overrun minus the acknowledged amount reaches the threshold.
- **Free usage never touches pack money.** Free paths change only window, slice and ai `held` by their own bound. A second, static guard sits on top: Σ windows + packs ≤ ai.
- **Exactly-once settlement.** A request leaves `calling` exactly once (`_settle` raises otherwise, under the lock). Each entitlement or quota reservation is therefore consumed or released exactly once.
- **At most one lot per order,** whatever the replays or event order. Three guards ensure it: the `payment_events` primary key, the explicit order state branches, and the `lots` primary key on `order_id`.
- **No deadlocks.** Every mutating function locks `gate` first and takes no other lock before it.
- **Constraints back everything up.** CHECK and UNIQUE constraints abort any bug instead of corrupting state.

## 5. State machines

**AI request (`requests.state`)**
- `calling` becomes `succeeded` via `complete`: the result is saved, money is charged, and the free quota (`used+1`) or the paid credit/follow-up is consumed.
- `calling` becomes `failed` via `fail`: money is charged by billing (none = 0, known = actual, unknown or bound = the bound), and the quota, credit or follow-up is released.
- `calling` becomes `expired` via the reaper once the lease has passed: the bound is charged and the entitlement released.
- A later `complete` on an expired request returns `late`. It stores the text for replay only.

**Client request id**
- Same id with the same input: `existing`, which replays, or 202 while it is still running.
- Same id with different input or mode: 422 `key_reused`.
- An existing request that failed or expired with no result: 409 `retry_new_key`.

**Free quota (`subject_usage` for a visitor, window and purpose)**
- `reserved+1` at admission. Success moves the slot from reserved to used.
- A failure releases the slot. If the failure cost money, `failed+1`; reaching `failed_cap` denies `subject_failures`.

**Lot (credits of one paid order)**
- `open` → `closed` when every reading and every follow-up has been used and nothing is calling. The leftover allocation is released from ai and packs.
- `open` → `revoking` on a full refund or dispute. It becomes `revoked` once nothing is calling, and the leftover is released.
- Paid reading reservation: `readings_reserved+1` and `alloc_held+take`. Success means `readings_used+1` plus a `paid_readings` row with 2 follow-ups. Failure or expiry restores the credit.

**Paid follow-ups (`paid_readings`)**
- Reserve requires the `reading_hash` to match, `reserved+used < total`, and the lot to be open.
- Success: `used+1`. Failure: the slot is released.

**Order (`orders.state`)**

| From | Event | To | Holds |
|---|---|---|---|
| (none) | `create_order` | `pending` | Held: ai+packs alloc, reserve fee |
| `pending` (no session, older than 10 min) | Reaper | `canceled` | Released |
| `pending` | `checkout.session.expired` or `sync:expired` | `expired` | Released |
| `pending` | `async_payment_failed` | `canceled` | Released |
| `pending` | Paid, amount matches | `paid` plus a lot | Alloc becomes the lot; fee becomes spent (`fee_estimate`) |
| `pending` | Paid, amount mismatch | `needs_review`, sales closed | Kept until revoke |
| `expired` or `canceled` | Paid | `paid` if the caps allow re-acquiring, else `paid_unfunded` (sales closed, operator refunds) | Re-acquired, or none |
| `paid`, `paid_unfunded` or `needs_review` | Full refund or dispute | `revoked` (lot revoking) | Released if held |
| any | Partial refund | Unchanged, `review_note='partial_refund'` | Unchanged |
| test or fake | `ledger-admin revoke-mode` | `canceled` or `revoked` | Released |

## 6. Pricing and bounds

**Price table.** Integer nano-USD per token, checked against the claude-api reference cached 2026-09-25.
- Cache writes are 1.25x input (5-minute TTL) and 2x input (1-hour TTL).
- Thinking tokens are billed inside `output_tokens`.
- Fallback attempts bill at the fallback model's own rate.
- `usage.iterations` is the per-attempt source of truth: refused attempts are `message` entries, and the serving fallback is a `fallback_message` entry.

| Model | in | out | cache write 5m | cache write 1h | cache read |
|---|---|---|---|---|---|
| claude-opus-5-5 | 4000 | 20000 | 5000 | 8000 | 200 |
| claude-opus-5 | 5000 | 25000 | 6250 | 10000 | 500 |
| claude-opus-4-8 | 5000 | 25000 | 6250 | 10000 | 500 |
| claude-sonnet-5-5 | 2000 | 10000 | 2500 | 4000 | 200 |
| claude-sonnet-5 | 2000 | 10000 | 2500 | 4000 | 200 |
| claude-haiku-4-5 | 1000 | 5000 | 1250 | 2000 | 100 |
| claude-fable-5-1 | 10000 | 50000 | 12500 | 20000 | 250 |
| claude-fable-5 | 10000 | 50000 | 12500 | 20000 | 1000 |
| `PRICE_CEILING` (unknown served model; also raises an alert) | 15000 | 60000 | 18750 | 30000 | 1500 |

**Price resolution**
- **Requested model:** env overrides (`AI_PRICE_*`; cache writes default to 1.25x/2x of the input override, cache reads to 0.1x), then the table, then the legacy default. The legacy default is Parley `openai-compatible` 1/5 (development only); everything else uses the ceiling.
- **Fallback targets:**

| Requested model | Fallback targets |
|---|---|
| opus-5-5 | opus-5, opus-4-8 |
| sonnet-5-5 | sonnet-5 |
| opus-5 | opus-4-8 |
| fable-5-1 | opus-4-8, opus-5 |
| others | none |

  `AI_FALLBACK_MODELS` overrides this.
- **Attempts with no model:** the first attempt is priced at the requested model; a `fallback_message` attempt at `maxPrice(fallback targets)`.

**`fromAnthropic`**
- Uses `usage.iterations` when it parses (zod; per-entry `model` is optional because it was not verified).
- Otherwise uses the top level, with `servedModel = res.model`.
- If `res.model` differs from the requested model and there are no iterations, `complete=false` (charge the bound).
- Cache writes come from `cache_creation.ephemeral_5m/1h_input_tokens`. If that breakdown is missing but `cache_creation_input_tokens > 0`, all writes are priced at the 1-hour rate.

**OpenAI**
- Reasoning tokens are inside `completion_tokens` and billed as output.
- Cached prompt tokens are billed at full input price (conservative).
- Missing usage means `complete=false`.

**Formulas**

```
cost  = ceil( Σ_attempts (input·inN + cw5m·cw5mN + cw1h·cw1hN + cacheRead·crN + output·outN) / 1000 )   // micro-USD
bound = Σ_{i=0..hops} ceil( (ceil(utf8Bytes(JSON.stringify({system,messages,schema})) · tokensPerByte) + 2048) · inN_i
                            + maxOutputTokens · outN_i , 1000 )
```
- `hops` = `AI_FALLBACK_MAX_HOPS` (default 1) when fallbacks are on and the model supports them; otherwise 0.
- Attempt 0 uses the requested model's price. Attempts 1 and later use `maxPrice(fallback targets)`.
- `tokensPerByte` is 1.0, which is provable because a token is at least one UTF-8 byte.
- The app sends no `cache_control`. If it ever does, `inN` becomes max(in, cw5m, cw1h).
- Every attempt's output is capped by `max_tokens`, so cost ≤ bound whenever the token counts are within those bounds.

**Worked numbers.** These are D1's offline measurements of worst-case input including the 2048 margin: tarot zh 11,989 bytes; paid follow-up (2nd turn) zh 25,089. `scripts/budget-plan.ts` recomputes them.

| Model | Tarot bound | Follow-up bound | Pack alloc, 5 x (1 reading + 2 follow-ups), 1 attempt |
|---|---|---|---|
| Sonnet 5.5, no fallback | $0.0540 | $0.0622 | $0.89 |
| Sonnet 5.5, 1 fallback hop | $0.108 | $0.124 | $1.78 |
| Opus 5.5, 1 hop to Opus 5/4.8 | $0.243 | $0.280 | $4.01 |
| Haiku 4.5 | $0.027 | $0.031 | $0.45 |

- **Fee hold:** 500 x 4.40% + 30 cents = $0.52 per pack (deliberately above the 2.9% + $0.30 US domestic rate).
- **Demo day:** a typical call (3.8k in, 860 out at $2/$10) costs about $0.0162, so 1000 calls cost about $16 against the $35 window. The call cap is 2500. Peak holds are 24 in flight x about $0.108 ≈ $2.6.
- **Packs that fit:** with a $5 pack pool, $1 slack and Sonnet 5.5 without fallback, floor(4 / 0.89) = 4 packs.

## 7. Config, environment and event plan

### 7.1 Environment variables (server-only; defaults in brackets)

**Identity and operators**
- `SESSION_SECRET`: required on any deployed host, at least 32 random bytes in base64url. Without it AI is `unconfigured`. Local development falls back to a fixed development secret with a warning.
- `OPS_TOKEN` [unset]: at least 24 characters. Enables `/api/ops/session`; without it there are no operator devices.
- `CRON_SECRET` [unset]: without it, GET `/api/ops/reconcile` returns 404.
- `AI_ACCESS_CODE` (existing): the venue gate.
- `MOONA_DEPLOYED` [unset]: set to `1` to treat a non-serverless host as deployed.

**Ledger**
- `DATABASE_URL`: the Supabase transaction pooler on port 6543, with user `moona_app`.
- `DATABASE_OWNER_URL`: scripts only. Never set on Vercel.
- `DATABASE_POOL_MAX` [2], `DATABASE_QUERY_TIMEOUT_MS` [4000], `DATABASE_CA_CERT` [unset; a PEM file path].
- `MOONA_LEDGER` [auto]: auto | postgres | pglite | memory | file.
- `MOONA_PGLITE_DIR` [.data/pglite].
- `MOONA_PLAN` [dev]: dev | event-2026-10-28.
- Plan overrides:
  - `AI_TOTAL_USD`, `AI_WINDOW_USD` (format `testing:10,demo:35,after:5`).
  - `AI_DEMO_HOURLY_USD` [15; 0 turns it off].
  - `PACK_POOL_USD` [0 in the event plan], `PACK_SLACK_USD` [1].
  - `BUDGET_CASH_TOTAL_USD` [100], `BUDGET_HOSTING_USD` [20], `BUDGET_RESERVE_USD` [30].
- Admission and health:
  - `AI_INFLIGHT_MAX` [24], `AI_SUBJECT_INFLIGHT_MAX` [2], `AI_LEASE_SECONDS` [120].
  - `AI_OVERRUN_TRIP_USD` [0.50], `AI_WARN_AT` [0.5,0.8,0.95].
  - `AI_MINT_NET_LIMIT` [400] per `AI_MINT_NET_WINDOW_S` [600].
  - `AI_UNKNOWN_TRIP` [5], `AI_UNKNOWN_COOLDOWN_S` [60], `AI_RL_TRIP` [5], `AI_RL_WINDOW_S` [60], `AI_RL_COOLDOWN_S` [20].
- `AI_PRIOR_SPEND_USD` [0]: recorded by `ledger-admin sync-plan` as entry `prior-spend` on `ai` and `win:testing`. It is idempotent; any later value needs `--entry prior-spend-2`.
- `AI_RESULT_TTL_MIN` [120] for free results; `PAID_RESULT_TTL_DAYS` [30].
- `AI_OPERATOR_QUOTA_EXEMPT` [1].
- Legacy file ledger, unchanged: `AI_MAX_CALLS_PER_DAY` [300], `AI_MAX_USD_PER_DAY` [5], `AI_MAX_USD_TOTAL` [25], `AI_USAGE_FILE`.

**AI provider and pricing**
- `AI_PROVIDER` gains `fake`. It is allowed only when not deployed, or when `AI_ALLOW_FAKE_ON_DEPLOY=1` (preview rehearsal).
- Fake provider: `FAKE_AI_PRICE_AS` [claude-sonnet-5-5], `FAKE_AI_LATENCY_MS` [0], `FAKE_AI_FAILURES` [""; example `timeout:0.01,rate_limited:0.02,refusal:0.01,bad_json:0.01`], `FAKE_AI_USAGE` [typical].
- Fallbacks: `AI_FALLBACKS` (existing), `AI_FALLBACK_MODELS`, `AI_FALLBACK_MAX_HOPS` [1].
- Prices: `AI_PRICE_INPUT_PER_MTOK` and `AI_PRICE_OUTPUT_PER_MTOK` (existing), plus `AI_PRICE_CACHE_WRITE_5M_PER_MTOK`, `AI_PRICE_CACHE_WRITE_1H_PER_MTOK`, `AI_PRICE_CACHE_READ_PER_MTOK`.
- `AI_INPUT_TOKENS_PER_BYTE` [1.0]. Lower it only after test-mode calibration; any underestimate shows up as overrun and trips the breaker.
- `AI_MAX_OUTPUT_{TAROT,CHAT,TALK,NATAL,HOROSCOPE}` [3000, 1200, 1200, 5000, 1500], thinking included. Effort stays `low`.

**Payments and store**
- `PAYMENTS_MODE` [off]: off | fake | test | live.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`.
- `FAKE_WEBHOOK_SECRET` [a fixed development constant when not deployed], `PAYMENTS_ALLOW_FAKE_ON_DEPLOY`.
- `PAYMENTS_LIVE_CONFIRM`: must equal `I_ACCEPT_REAL_CHARGES`.
- `COMMERCIAL_ASSETS_CLEARED`: must be `1` for live.
- `STORE_TERMS_URL`, `STORE_REFUND_POLICY_URL`, `STORE_SUPPORT_CONTACT`.
- `AUTH_PROVIDER` [none]: none | fake.
- Pack: `STORE_PACK_PRICE_CENTS` [500], `STORE_PACK_CURRENCY` [usd], `STORE_PACK_READINGS` [5], `STORE_PACK_FOLLOWUPS` [2], `STORE_ATTEMPTS_PER_UNIT` [1].
- Limits and fees: `STORE_MAX_PACKS_LIVE` [10], `STORE_MAX_PACKS_TEST` [3], `STORE_FEE_BP` [440], `STORE_FEE_FIXED_CENTS` [30], `STORE_CHECKOUT_TTL_S` [1860].
- `NEXT_PUBLIC_SITE_URL` (existing): used for the success and cancel URLs.

### 7.2 Plan profiles (`src/lib/ledger/plans.ts`)

**`event-2026-10-28`.** Absolute instants with explicit offsets. DST ends on 2026-11-01, inside `after`.

| Pool | Value |
|---|---|
| cash | $100 = ai $50 + hosting $20 (manual entry) + reserve $30 (fees, taxes) |
| packs | $0 by default, so sales stay closed. To sell, lower a window, for example demo $30 + packs $5. |

| Window | From | To | USD cap | Calls cap | Slice | Mint cap |
|---|---|---|---|---|---|---|
| `win:testing` | 2026-10-09T00:00-04:00 | 2026-10-28T00:00-04:00 | $10 | 3000 | $3 per UTC day | 300 |
| `win:demo` | 2026-10-28T00:00-04:00 | 2026-10-29T06:00-04:00 | $35 | 2500 | $15 per hour | 3000 |
| `win:after` | 2026-10-29T06:00-04:00 | 2026-11-28T00:00-05:00 | $5 | 800 | $1 per UTC day | 1000 |

Free quotas per visitor and window, as per_subject/failed_cap:

| Window | tarot | chat | talk | natal | horoscope |
|---|---|---|---|---|---|
| testing | 30/20 | 60/20 | 60/20 | 15/10 | 30/10 |
| demo | 2/3 | 4/3 | 4/3 | 1/2 | 3/2 |
| after | 1/2 | 2/2 | 2/2 | 1/1 | 1/1 |

- **Operating parameters:** in-flight 24; per-subject in-flight 2; lease 120 s; overrun trip $0.50; unknown-billing trip 5 with a 60 s cooldown; rate-limit trip 5 in 60 s with a 20 s cooldown; mint ceiling 400 per 600 s per net bucket; checkout TTL 1860 s; warnings at 0.5/0.8/0.95.
- **Cost and call caps are independent.** Whichever trips first denies.
- **Holds are counted at admission,** so the caps always leave room for requests in flight.

**`dev`**
- One window `win:dev`, 2026-01-01Z → 2027-01-01Z, $20, with no call cap and a $5 per UTC day slice.
- Quotas are 100/50 for every purpose. ai $25; packs $5 (fake mode works locally); hosting $0; reserve $30; cash $100.

**Product `tarot5`:** $5.00 usd, 5 readings, 2 follow-ups each, attempts 1. Allocation is computed (§6). Fee hold $0.52. Max sold: test 3, live 10.

### 7.3 Payment state rules (`paymentsConfig`)

| State | When |
|---|---|
| `unconfigured` | `PAYMENTS_MODE` is unset or `off`. |
| `fake` | Not deployed (or `PAYMENTS_ALLOW_FAKE_ON_DEPLOY=1`), and the ledger is sql (postgres, pglite or memory). |
| `test` | Key starts `sk_test_` or `rk_test_`, the secret starts `whsec_`, the price id starts `price_`, and the ledger is sql. |
| `live` | Key starts `sk_live_` or `rk_live_`, `whsec_`, `price_`, `PAYMENTS_LIVE_CONFIRM=I_ACCEPT_REAL_CHARGES`, `AUTH_PROVIDER` is neither none nor fake, the ledger is postgres, terms, refund and support values are set, `COMMERCIAL_ASSETS_CLEARED=1`, and `NEXT_PUBLIC_SITE_URL` is https. |
| `misconfigured` | Any precondition fails. `problems[]` lists every failure; operators see it, the public sees the `unconfigured` copy. |

- `webhookEnabled` is true for fake, test and live, **even while sales are closed**, so late events and refunds are still processed.
- **Sales open** only when all of these hold; the first failing reason is shown: state is fake, test or live; operator device if test or fake on a deployed host (`operators_only`); auth ready (`login_unavailable`); ledger ok; breaker ok (`paused`); sales flag open (`closed`); packs cap > 0 (`no_pack_pool`); sold < max for the mode (`sold_out`); headroom for alloc + slack, and reserve room for the fee hold (`budget_short`). `create_order` re-checks all of this atomically.

### 7.4 `validatePlan`

**Errors**
- Windows overlap, or a window lacks quotas for any of the five purposes.
- Σ windows + packs > ai, or ai + hosting + reserve > cash.
- Lease ≤ route `maxDuration` (60), or `maxDuration` ≤ the maximum provider timeout (natal 40 s).
- Any non-integer or negative value.

**Warnings**
- Demo `callsCap` < 1000, or demo cap < 1000 x the typical cost of the configured model.
- floor((packs − slack) / alloc) < 1 while payments are not `unconfigured` ("sales stay closed").
- `maxSoldLive` x fee hold > reserve.
- A slice cap below the cost of 300 typical calls.

## 8. API routes

### 8.1 AI routes

`POST /api/ai/{tarot,chat,talk,natal,horoscope}`. Each route exports `maxDuration = 60` and no `runtime`. Each route body becomes `return handleAi(req, spec)`. The existing parse, crisis and fact checks become `parse` and `preflight`; prompt and validate functions are reused unchanged.

**Request additions**
- `requestId?: string` (`^[A-Za-z0-9_-]{16,64}$`). If missing, the server generates one, which means no idempotency for that request.
- Tarot: `use?: "free" | "paid"`. Paid is never assumed.
- Chat: `paidReadingId?: string`.

**Handler order**
1. Access check: `unconfigured` or `locked` gives 503.
2. Parse: 400 `bad_request`.
3. Preflight: crisis gives 200 `{code:"crisis"}`; bad facts give 400. Nothing is reserved.
4. `getLedger`: not ok gives 503 `ledger`.
5. `ensureVisitor`: 429 `visitor_cap`.
6. The file ledger applies `burstLimit` (429 `rate_limited`).
7. Paid path: needs an account, else 401 `login_required`.
8. `meteredGenerate`.
9. Response, plus Set-Cookie if a visitor was minted.

**Subjects**
- Free: `v:<visitor>`.
- Paid: `a:<account>`.
- Horoscope uses `cacheScope "shared"` only when `subject.mode === "sign"` and there is no moon and no rising; otherwise `"subject"`.

**Hashes**
- `inputHash` over canonical `{purpose, versions, provider, model, maxOutput, mode, parsed}`.
- `readingHash` over spread, topic, question and cards.
- Result TTL: free 7200 s; shared 93600 s; paid `PAID_RESULT_TTL_DAYS`.

### 8.2 Status codes (`meterResponse`)

| Code | Body | When |
|---|---|---|
| 200 | `{...respond(value, meta), replayed?: true, paidReadingId?, followupsLeft?, budgetLevel?}` | Fresh, `existing` with a result, or `cached`. `meta = {provider, model, generatedAt, versions, source}`; no cost. |
| 202 | `{code:"in_progress", retryAfterMs}` | Same id still running, or the same input in flight. |
| 400 | `bad_request` / `bad_facts` | Parse or preflight failure. |
| 401 | `login_required` | Paid request without an account. |
| 402 | `{code:"no_credits", sales}` | No credits left. |
| 409 | `retry_new_key` / `no_such_reading` / `reading_mismatch` / `no_followups` / `lot_closed` | |
| 422 | `key_reused` | Same id, different input or mode. |
| 429 | `{code:"quota", credits}` / `subject_failures` / `subject_busy` (retryAfterMs 3000) / `visitor_cap` / `rate_limited` | |
| 503 | `unconfigured` (also plan unsynced) / `locked` / `ledger` / `budget` (no_window, total_usd, window_usd, window_calls, slice_usd, purpose_closed) / `busy` (retryAfterMs 2000–5000) / `cooldown` (retryAfterMs from the server) / `paused` / `paid_capacity` | Existing clients already treat 503 as offline. |
| 502 / 504 | As today | `upstream`, `bad_output`, `refused` / `timeout` |

### 8.3 Other routes

- **`GET /api/ai/status`**
  - Unavailable: exactly `{available:false, reason}`, where reason is `unconfigured | locked | budget | ledger`. This keeps the `toEqual` assertions in `ai.test.ts` passing.
  - Available: `{available:true, reason:null, level, provider?, model?, budget?}`. `provider`, `model` and `budget` are shown only with access, or with no access code configured, or to operators. For the file ledger, `budget` is the legacy snapshot; for SQL it is the `LedgerSnapshot` plus levels and `planMismatch`.
  - Always `Cache-Control: no-store`.
- **`GET /api/packs`** → `{ payments: {state, problems?}, sales: {open, reason}, product: {priceCents, currency, readings, followupsPerReading, excludes:["talk","natal"], model, termsUrl, refundUrl, support}, account: {signedIn, provider}, entitlements?: EntitlementView }`, with `no-store`. `problems` are shown to operators only.
- **`POST /api/packs/checkout`** with `{productId:"tarot5", checkoutKey}` (the client id from `newRequestId`).

  | Status | Body |
  |---|---|
  | 200 | `{url, orderId}` |
  | 401 | `login_required` |
  | 404 | `payments_off` (state unconfigured or misconfigured) |
  | 409 | `{code:"sales_closed", reason}` / `sold_out` / `budget_short` / `order_closed` |
  | 502 | `provider_error` |
  | 503 | `ledger` |

- **`GET /api/packs/orders/[id]`**: owner only. It calls `syncOrder` (a Stripe retrieve, then fulfil or expire) and returns `{order, credits}`. Responses: 401, 404, 503.
- **`POST /api/stripe/webhook`** (`maxDuration = 15`).
  - Reads `raw = await req.text()`.
  - 404 when the webhook is disabled.
  - Bad or stale signature: 400 `bad_signature`, with zero database writes.
  - `livemode` mismatch: 400.
  - Ledger unavailable: 503, so Stripe redelivers.
  - Bug: 500.
  - Otherwise always 200 `{received:true, outcome}`, so a replay is a no-op.
- **`POST /api/ops/session`** with `{token}`: sets `moona_ops`, or returns 401. Failed attempts are throttled to 10 per 10 minutes per instance. `DELETE` clears it.
- **`GET /api/ops/reconcile`** (`Authorization: Bearer CRON_SECRET`) or **`POST`** (operator cookie): runs `reconcile()` and returns `{reaped, ordersSynced, purged, auditViolations, level}`. Any audit violation trips the breaker.
- **`POST /api/ops/fake-pay`** with `{orderId, outcome, duplicate?}`: fake mode only, and only when not deployed or for an operator. Calls `createFakePayments(...).deliver`.

## 9. Flows

**A. AI request (free or paid)**
1. Before fetching, the client persists `requestId` on the record: `reading.aiRequest[locale]`, or the chat turn's `requestId`.
2. The route runs the gates, then the identity steps.
3. The server computes `bound = requestBoundMicro`, then calls `reserve`.
   - `existing` or `cached` → replay with 200, no spend.
   - `in_progress` → 202. The client re-POSTs the same body after `retryAfterMs`.
   - `denied` → the code from §8.2.
4. On `reserved`, the provider is called exactly once (SDK `maxRetries` 0, provider timeout < 60 s < 120 s lease).
5. Success with valid output → `complete` (charged = cost, or the bound when usage is incomplete). It is retried 3 times on `LedgerUnavailable` (100/400/1200 ms). If all retries fail, the result is still returned; the reaper later charges the bound and gives the credit back.
6. Invalid output → `fail(known)`. An `AiError` → `fail(none | known | unknown)`, passing the rate-limit flag and retry-after.
7. No provider call happens unless `reserve` returned `reserved`. A ledger error on `reserve` fails closed.

**B. Checkout → webhook → grant**
1. `GET /api/packs` shows the banner (§10.4). The purchase action follows `purchaseAction`.
2. `POST /api/packs/checkout`:
   - `create_order` holds the allocation, slack check and fee before any redirect. It is idempotent on `checkoutKey` and allows one pending order per account.
   - If the order already has `checkout_url`, it is returned.
   - Otherwise `stripe.checkout.sessions.create(...)` runs with `idempotencyKey order:<id>` and the stored `expires_at`.
   - Then `attach_session`. If the order is no longer pending, the session is expired at Stripe and 409 is returned.
   - The URL is released only after attach, so a webhook can never precede attach.
3. The user pays on Stripe. The webhook verifies the signature, normalises the event and calls `fulfil` (event id dedupe, session, livemode, amount and currency checks, then grant).
4. The return URL is `/me?order=<id>#packs`. `PacksPanel` polls `GET /api/packs/orders/<id>` every 2 s for up to 2 minutes, and the server retrieves the session (covering a webhook that arrives after the redirect).
   - Sync event ids are `sync:paid:<cs>` and `sync:expired:<cs>`. Fulfil is called only when retrieve says complete+paid; expire only when it says expired.
   - The redirect itself never grants anything. Credits are always read from the server.

**C. Recovery**

| Failure | Recovery |
|---|---|
| Crash before or during the provider call | The lease expires and the next `reserve` (or reconcile) reaps it: bound charged, entitlement released. A late result is kept for replay only. |
| Crash after `complete` | A retry with the same `requestId` gets `existing`, which replays with no second charge. |
| Order without a session | Canceled after 10 minutes. |
| Order with a session | Released only after Stripe confirms expiry (webhook, or a verified retrieve). If Stripe is unreachable the hold stays. |
| Provider outage | 5 unknown-billing failures in a row cause a 60 s cooldown. 5 rate-limit replies (429/529) within 60 s cause a cooldown of max(20 s, retry-after). |
| Bound overrun | The breaker pauses AI and sales until an operator runs `ledger-admin set-flag breaker ok`. |
| Ledger down | AI routes return 503 `ledger` and checkout returns 503. Webhooks return 503 so Stripe redelivers. Offline features keep working. |

**D. Closing sales**
- Sales close automatically on any of: `budget_short`, `sold_out`, `paid_capacity`, `amount_mismatch`, `paid_unfunded`, or the breaker.
- Operators can close them manually with `set-flag sales closed`.
- Packs already sold keep their held allocation; free usage cannot reach it. Refunds go through the Stripe dashboard and are processed by the webhook.

## 10. UI changes (prototype style)

Style rules for all new UI:
- `.panel` glass, `.h2`/`.h3` in Instrument Serif (`--font-display`), `.eyebrow` in Geist Mono.
- Gold `var(--accent)` #c9a96e for hairlines and meters. Cyan stays reserved for the live-AI pulse.
- The test-mode badge uses `.badge .badge-dev` (`--warn`).
- No emoji; lucide-react or `icons.tsx` SVG only.

### 10.1 Data and copy

- **`src/lib/tarot/types.ts`**: `Reading.aiRequest?: Partial<Record<Locale, string>>`, `Reading.paid?: { paidReadingId: string; followupsLeft: number; locale: Locale; requestId: string }`, `ChatTurn.requestId?: string` (user turns).
- **`i18n/{en,zh}.ts`**: add `m.packs.*` and the new AI status lines below.

| Situation | EN | ZH |
|---|---|---|
| quota | "You've used this event's free live readings here. The offline reading below is complete." | "本场的免费实时解读已用完。下方的离线解读是完整的。" |
| budget | "Tonight's live AI readings are used up. This reading comes from MOONA's offline card engine." | "今晚的实时 AI 解读额度已用完。这份解读来自 MOONA 的离线牌义引擎。" |
| ledger or paused | "Live AI is paused for a moment. Everything else works; your offline reading is below." | "实时 AI 暂停中，其他功能照常；离线解读在下方。" |
| low (warn or critical) | "Live readings are running low tonight." | "今晚的实时解读额度所剩不多。" |
| busy after retries | "Too many readings at once. Your offline reading is below; try live AI again in a minute." | "同时请求太多，请稍后再试；离线解读在下方。" |
| simulated badge | "Simulated reading — no AI call" | "模拟解读——未调用 AI" |

### 10.2 Pages and components

- **`src/app/tarot/r/[id]/page.tsx`**
  - The free generation keeps its automatic start on page open, but goes through `requestAi` with a persisted `requestId`. "Try again" makes a new id.
  - On `quota`:
    - With credits > 0 (signed in): show the panel "Use 1 of your N pack readings for this spread?" with a button. The paid request starts only on that explicit tap.
    - With credits = 0 and sales open: link "Reading packs" to `/me#packs`.
    - Otherwise: the plain offline line.
  - After a paid success, save `reading.paid` and show "Pack reading, 2 follow-ups included".
  - `meta.provider === "fake"` shows the simulated badge. `budgetLevel` warn or critical shows the low line.
- **`src/components/TarotChat.tsx`**
  - Each user turn persists its `requestId`.
  - With `reading.paid` and follow-ups left > 0, send `paidReadingId` and show "Pack follow-ups left: N" with a gold `CreditMeter`.
  - At 0, fall back to the free chat quota and say so.
- **`HoroscopePanel.tsx`, `NatalReport.tsx`, `chat/Conversation.tsx`, `src/app/page.tsx`**: switch to `requestAi`, using an id per attempt (persisted where a record exists).
- **`src/app/me/page.tsx`**: `SECTIONS` becomes `[..., "saved", "packs", "settings", "data"]`; render `<section id="packs"><PacksPanel/></section>`.
- **`PacksPanel`** shows, in order:
  - The `PaymentModeBanner`.
  - Product terms, rendered only for live+open (and for test/fake to operators), stated before payment: price; 5 full tarot AI readings, each with 2 follow-ups; Talk and birth-chart reports not included; re-reading saved results is free; failed readings return the credit; the model/service; refund and support links.
  - `CreditMeter`: remaining credits / total, as a gold hairline (`.credit-meter`: height 2px, background `var(--line)`, fill `var(--accent)`).
  - A list of paid readings with follow-ups left.
  - Orders, with plain state labels.
  - The purchase button:
    - live+open: `btn btn-primary`, "Buy 5 readings — $5.00".
    - test+open: `btn`, "Test purchase (no real charge)". Operators only when deployed.
    - fake: `btn`, "Simulated purchase".
    - Otherwise: no button.
  - `checkoutKey` is kept in `sessionStorage` (wrapped in try/catch) for resume.
  - `?order=` polling shows:
    - paid: "5 readings added."
    - pending: "Waiting for the payment provider to confirm. Your payment is safe; this page updates by itself."
    - expired/canceled: "Checkout closed. No charge was made."
    - `needs_review` / `paid_unfunded`: "We received your payment but could not add readings. It will be refunded; contact <support>."
  - With `AUTH_PROVIDER=none`: "Buying a pack needs an account so your credits survive a cleared browser. Sign-in isn't available on this site yet."
  - With fake auth: "Test account tied to this browser."
- **`src/app/packs/fake-checkout/[id]/page.tsx`**: a server component that returns `notFound()` unless the state is `fake`. Header "SIMULATED CHECKOUT — no payment provider, no money moves". Buttons Pay / Decline / Expire / Deliver twice post to `/api/ops/fake-pay`.
- **`src/app/about` and the route comments**: replace "nothing is stored server-side" with what is now stored: a pseudonymous visitor id, counters, HMAC input hashes (never question text), generated results for 2 h (free) or 30 days (paid), and orders and credits. Copy goes in both locales.

### 10.3 Purchase action rules

`purchaseAction` gives `buy` only for live+open; `test` only for test+open (and only for operators when deployed); `simulate` only for fake+open (same operator rule); otherwise `null`.

### 10.4 Banner copy (`m.packs.*`)

| State | Eyebrow | Body (EN / ZH) |
|---|---|---|
| unconfigured, misconfigured (public) | PAYMENTS NOT ENABLED / 支付未开通 | "Reading packs are not on sale. Payments are not enabled on this site. Every reading still works offline, free." / "解读包暂未开放：本站尚未开通支付。所有解读仍可免费离线使用。" |
| fake | SIMULATION / 模拟 | "Simulation — no payment provider is connected and no money moves." / "模拟模式：未连接任何支付服务，不会产生任何扣款。" |
| test (operator) | TEST MODE / 测试模式 | "Test mode — Stripe test cards only. No real charge, no real income." / "测试模式：仅限 Stripe 测试卡，不会产生真实扣款或收入。" |
| test (public, deployed) | TEST MODE / 测试模式 | "Packs are being tested and are not on sale yet." / "解读包正在测试，暂未开售。" |
| live, closed / sold_out / budget_short | READING PACKS / 解读包 | "Packs are sold out for now. Packs already bought keep working." / "解读包暂时售罄。已购买的解读包仍可正常使用。" |
| live, open | READING PACKS / 解读包 | Terms text (§10.2) and the CTA |

## 11. Tests (all offline; vitest)

**Helpers**
- `tests/helpers/ledger.ts`: `makeTestLedger({plan?, clock})` = PGlite in memory + `migrate({testClock:true})` + `syncPlan`; returns `{ledger, exec, clock}`.
- `tests/helpers/stripe.ts`: Stripe-shaped events plus `generateTestHeaderString`.
- Every ledger test asserts `await ledger.audit()` is `[]` after each step.

**`tests/identity.test.ts` (S0)**
- A forged, garbled or wrong-key cookie is treated as absent.
- Two visitors behind the same `x-forwarded-for` get independent burst limits.
- Minting sets an httpOnly, SameSite=Lax cookie (Secure only on https).
- `VERCEL=1` without `DATABASE_URL`: an AI route returns 503 `ledger`, fetch is never called, and status reason is `ledger`.
- No `SESSION_SECRET` on a deployed host gives `unconfigured`.

**`tests/pricing.test.ts`**
- Anthropic usage (input 1000, `cache_creation` 5m 400 / 1h 200, `cache_read` 300, output 500) on opus-5-5 equals the exact ceil of the integer nano math.
- `usage.iterations` [message on opus-5-5, fallback_message on opus-5] prices each attempt at its own model.
- An iteration without a model uses the requested model (primary) or the fallback max.
- A fallback without iterations gives `complete=false`.
- An unknown served model uses `PRICE_CEILING` and is listed in `unknownModels`.
- `PRICE_CEILING` is component-wise ≥ every table row.
- The bound with fallbacks on equals the sum of both hops.
- Property test (seeded mulberry32): 5000 random valid tarot/chat/talk/natal/horoscope requests (en/zh, maximum lengths, every spread). For any usage with input ≤ bytes+2048, output ≤ max_tokens and attempts ≤ 1+hops, cost ≤ `requestBoundMicro` ≤ `worstCaseBoundMicro`.
- `requestCostBound` equals bound/1e6.

**`tests/usage.test.ts`**
- Anthropic HTTP 400 → billing `none`; 429 and 529 → `none` + `rateLimited` + `retryAfterS`; 500 and timeout → `unknown`; refusal and max_tokens → `known` with usage.
- A 529 produces exactly one fetch.
- OpenAI reasoning tokens inside `completion_tokens` are billed as output; cached prompt tokens are billed at full input.
- Parley with no usage gives `complete=false`.

**`tests/ai.test.ts` (existing)**
- Every assertion passes unchanged on the file ledger: refusal billing $0.02, caps, restart, corrupt ledger fails closed, status contract.

**`tests/ledger.smoke.test.ts`**
- PGlite loads, migrations 001, 002 and 900 apply, a plpgsql function runs, and a re-run of `migrate` applies nothing.
- Changing the 002 checksum re-applies it; changing 001 throws.
- This is the first gate for the PL/pgSQL assumption.

**`tests/ledger.free.test.ts`**
- `reserve` → `complete` moves the window, slice and ai from held to spent and sets subject `used=1`.
- The same input with a new id → `cached` with zero counter change.
- The same id → `existing`. The same id with a different hash → `key_reused`.
- A different id with the same input while calling → `in_progress`.
- Cost cap and call cap are independent: calls exhausted with money left → `window_calls`; money exhausted with calls left → `window_usd`.
- `slice_usd` trips before `window_usd`; the next hour's slice admits again.
- The 4th reserve at cap = 3 bounds + (bound − 1) → `total_usd`.
- `subject_quota`; `quota_exempt` bypasses the quota but not the money caps.
- `fail(none)` charges 0, refunds calls and leaves `failed` unchanged.
- `fail(known)` charges the actual.
- `fail(unknown)` charges the bound; the 5th in a row sets the cooldown and `reserve` → `cooldown` with `retry_after_s`.
- `failed_cap` → `subject_failures`.
- `inflight_cap` → `busy`; `subject_inflight_cap` → `subject_busy`.
- 5 rate-limited fails within 60 s → cooldown; spread over more than 60 s → none.
- A request reserved at 23:59:59.999 in testing and completed in demo settles into testing.
- No window → `no_window`.
- The free cache never returns a paid request's result.

**`tests/ledger.reaper.test.ts`**
- An expired lease is reaped by the next `reserve`: bound charged, quota/credit/follow-up released, in-flight count decremented.
- A late `complete` → `late` and stores the text for replay (`existing` replays it); no money change.
- A late `fail` → `late`.
- `purge_results` nulls the result after its TTL, and `existing` then → `retry_new_key` at the route level.

**`tests/ledger.plan.test.ts`**
- `sync_plan` raises on: overlapping windows; Σ windows + packs > ai; ai + hosting + reserve > cash; a cap below spent+held; a pool changing kind.
- Switching dev → event closes `win:dev` at now and counts its spent+held in the split.
- Future unlisted windows are deleted.
- Prior spend recorded twice → `duplicate`.
- `validatePlan` flags lease ≤ maxDuration, a demo call cap < 1000, and "no pack fits".
- The event plan validates with no errors.

**`tests/ledger.concurrency.test.ts`**
- PGlite serializes statements, so this proves per-call atomicity, not row locking.
- `Promise.all` of 300 reserves against a cap that fits exactly N admits exactly N.
- 20 reserves with the same id give 1 `reserved` and the rest `existing` or `in_progress`.
- 50 identical fulfils give 1 lot.

**`tests/ledger.fuzz.test.ts`**
- 20 seeds x 2000 steps covering:
  - reserve (free, paid reading, follow-up);
  - complete; fail (none, known, unknown, rate-limited); abandon; clock advance; reap; purge;
  - create_order, attach, fulfil, duplicate and out-of-order events, expire, full and partial refund, dispute, revoke_mode.
- After every step:
  - `audit()==[]`.
  - spent+held ≤ cap+overrun for every pool.
  - No negative counter.
  - Each request leaves `calling` at most once.
  - At most one lot per order.

**`tests/ledger.pg.test.ts`**
- Skipped unless `TEST_DATABASE_URL` is set.
- The same contract and fuzz suites over a pg Pool with 20 connections, with real contention.
- 10k mixed operations with no 40P01 and an empty audit.

**`tests/meter.test.ts`** (memory ledger + fake provider)
- Success goes through `complete`.
- `bad_json` → `fail(known)`; timeout → `fail(unknown)`; 429 → `fail(none)` with the rate-limit flag.
- A transient `LedgerUnavailable` during `complete` is retried and succeeds.
- A persistent failure still returns the value, and the reaper later charges the bound.
- A ledger error during `reserve` → `unavailable` with no provider call.
- Over-bound fake usage → overrun recorded, breaker tripped, next `reserve` → `paused`.

**`tests/routes.ai.test.ts`** (`NextRequest` + `setLedgerForTests`)
- Replay of the same `requestId` returns 200 with `replayed:true` and one provider call.
- 422 `key_reused`, 409 `retry_new_key`, 202 `in_progress`, 429 `quota` with `credits`.
- 401 for `use:"paid"` without an account; 402 `no_credits`.
- A crisis never reserves (spy).
- Horoscope with a Sun-sign subject: two visitors share one provider call. With a moon or rising subject: never shared.
- `maxOutputTokens` from config appears in the provider request body (tarot 3000).
- Status levels at 50/80/95/100% map to notice/warn/critical/exhausted.
- Status shows budget only to access or operator devices, and never cost or keys.

**`tests/client.test.ts`** (mocked fetch, fake timers)
- 202 then 200 resolves `done` using the same id and body.
- 503 `busy` retries with jitter and stops at `maxWaitMs`, ending `offline/busy`.
- 409 → `retry`.
- `newRequestId` matches the format with `crypto.randomUUID` deleted.

**`tests/event-sim.test.ts`**
- Setup: 200 visitors with separate cookie jars and one shared `x-forwarded-for`. Three waves in three simulated demo hours. Fake provider with typical usage and 2% 429 / 1% timeout / 1% fallback. 5% double clicks, 3% reloads, 2% cleared cookies, and a 60 s ledger outage.
- Assertions:
  - All 1000 demand calls (1 tarot, 1 natal, 3 chat per visitor) are served.
  - Spend ≤ every cap, and no visitor exceeds quota.
  - Every request ends terminal after reap, and `audit==[]`.
  - Requests during the outage get 503 `ledger` with no provider call.
  - A rerun with `FAKE_AI_USAGE=max` hits `slice_usd` or `window_usd` before the 2500 call cap.

**`tests/ledger.paid.test.ts`**
- A paid reading reserves a credit and `alloc_held`; `complete` consumes it and creates exactly one `paid_readings` row with 2 follow-ups.
- `fail` restores the credit. Complete twice → `already`; complete after fail → `conflict`.
- The 3rd follow-up → `no_followups`. A wrong `readingHash` → `reading_mismatch`. Another account's id → `no_such_reading`.
- After 5 readings x 2 follow-ups the lot closes and its leftover leaves ai and packs.
- Repeated `fail(unknown)` exhausts the lot: the next reserve draws `extra` from the slack; once the slack is gone → `paid_capacity`, sales closed, credit still owed, `entitlements().unservable` = true.

**`tests/ledger.isolation.test.ts`**
- Fulfil a pack, then drain free usage until `total_usd` or `window_usd`.
- The lot allocation and pending-order holds are unchanged (row diff), and a paid reading is still admitted.

**`tests/orders.test.ts`**
- `create_order` holds ai+packs alloc and the reserve fee, is idempotent on `checkoutKey`, and allows one pending order per account (`pending_exists`).
- `sold_out` is counted per live/non-live.
- `budget_short` when the pack pool lacks alloc + slack, or the reserve lacks the fee. `sales_closed` when the flag or breaker is set.
- `checkout_expires_at` = created + 1860 s.
- `attach_session` is idempotent; `not_pending` after cancel.

**`tests/webhook.test.ts`** (official `stripe` SDK, offline)
- A valid `generateTestHeaderString` signature → 200 granted.
- Wrong secret, stale timestamp, or a re-serialized body → 400 with zero database writes. The route reads `req.text()`.
- The same event id twice → `duplicate_event`.
- `completed` + `async_payment_succeeded` for one session → 1 lot.
- `completed` with `unpaid` → `not_paid`, then `async_succeeded` → granted.
- Session, livemode or amount mismatch → no grant, outcome recorded, `amount_mismatch` closes sales.
- `expired` releases the holds; `expired` after paid is a no-op.
- Paid after expired re-acquires the holds, or gives `paid_unfunded` with sales closed when the budget is gone.
- Full refund or dispute → revoked: an in-flight paid request still completes, then the leftover is released.
- Partial refund → review note only.
- Ledger down → 503.

**`tests/payments.config.test.ts`**
- `off` → `unconfigured`, checkout returns 404.
- Test mode with an `sk_live_` key → `misconfigured` with the problem listed.
- Live without confirm, terms, refund URL, support, a real auth, a postgres ledger, `COMMERCIAL_ASSETS_CLEARED` or an https site → `misconfigured`, one problem per missing item.
- The webhook stays enabled while sales are closed.
- `salesState` reasons come in the documented order.
- Test or fake on a deployed host → `operators_only` for non-operators.

**`tests/packs.flow.test.ts`** (fake payments + fake auth + fake provider + memory ledger)
1. Buy.
2. The return page polls before the webhook; `syncOrder` grants.
3. The later webhook → `duplicate_event` or `already`.
4. Credits show 5.
5. A paid reading plus 2 follow-ups work; a 3rd follow-up falls back to the free quota; replays are free.

**`tests/recovery.test.ts`**
- A crash between `create_order` and attach → canceled after 10 minutes.
- An order with a session is never released by the reaper alone, only by an expired event or a verified retrieve.
- Stripe unreachable during reconcile → the hold stays.
- `revoke_mode` releases test/fake holds and revokes their lots.

**`tests/ui-honesty.test.ts`**
- `purchaseAction` returns `buy` only for live+open; `test` only for test+open (operators when deployed); `null` for unconfigured and misconfigured.
- `packsCopy` (en and zh): test contains "TEST MODE" or "测试模式" and "No real charge"; unconfigured contains "not enabled" or "尚未开通" with no CTA; fake contains "no money moves".
- The simulated badge text is never "Live AI".

**`tests/no-emoji.test.ts` (existing)** covers all new `ts`, `tsx`, `json` and `md` files automatically.

## 12. Dependencies and library notes

- **Add to `dependencies`:** `pg@^8.23.1`, `stripe@^23.0.0` (engines node>=20; the repo needs >=20.9).
- **Add to `devDependencies`:** `@types/pg@^8.23.1`, `@electric-sql/pglite@^0.5.8`.
- **No fast-check.** Fuzz and property tests use a seeded PRNG.

**Verified on the npm registry 2026-10-09:** pg 8.23.1, @types/pg 8.23.1, @electric-sql/pglite 0.5.8 (exports `.` and `./live`), stripe 23.0.0.

**APIs from knowledge, to confirm on install**

| Library | What to confirm |
|---|---|
| pg | `new Pool({connectionString, max, query_timeout, ssl})`, `pool.query(text, params)`. Stable. |
| PGlite | `new PGlite(dataDir?)` (memory when omitted), `db.query(text, params) → {rows}`, `db.exec(sql)`, and that plpgsql is available. The smoke test is the first gate. Fallback if plpgsql is missing: run the same function bodies as TypeScript transactions with `SELECT ... FROM moona.gate WHERE id=1 FOR UPDATE` first. |
| stripe-node v23 | `new Stripe(key, {maxNetworkRetries, timeout})`, `checkout.sessions.create/retrieve/expire`, `webhooks.constructEvent(raw, sig, secret)` (default 300 s tolerance), `webhooks.generateTestHeaderString({payload, secret, timestamp?})`. These are long-stable but must be checked. The webhook endpoint's API version should match the SDK's pinned version. Constructing `new Stripe("sk_test_offline")` for offline verification must not make a network call. |
| Supabase (Supavisor) transaction mode | Works with pg's unnamed statements, and custom roles via `moona_app.<project-ref>`. Verify with the gated pg suite. TLS uses `DATABASE_CA_CERT` (Supabase CA). |
| Anthropic `usage.iterations` | Whether each entry carries `model` is unverified, hence the conservative fallback pricing. Whether a pre-output refusal is billed depends on its category; whatever usage is reported is charged. |

**Not chosen**
- `postgres` (porsager): it needs `prepare:false` for the pooler, and `pg` is already auto-externalized by Next.
- `pg-mem`: incomplete PL/pgSQL, unusable for a ledger built on database functions.

**Other changes**
- `next.config.ts`: `serverExternalPackages: ["@electric-sql/pglite"]`.
- `package.json` scripts: `"ledger": "tsx scripts/ledger-admin.ts"` and `"budget:plan": "tsx scripts/budget-plan.ts"`.
- `scripts/ledger-admin.ts` commands: `migrate [--roles]`, `sync-plan`, `snapshot`, `audit`, `reap`, `reconcile`, `record-spend --pools ai,win:testing --usd N --kind prior_spend|manual_spend|dispute_fee|provider_correction --entry ID --note ...`, `set-flag breaker ok|tripped|sales open|closed --reason ...`, `revoke-mode-test --yes`. It uses `DATABASE_OWNER_URL` (or `MOONA_PGLITE_DIR`).
- `scripts/budget-plan.ts` prints bounds per purpose and locale, the pack allocation, packs that fit, fee holds, the ≥1000-call check and the `validatePlan` output, all offline.
- `scripts/rehearse.ts` (optional) runs HTTP load against `next start` with `AI_PROVIDER=fake PAYMENTS_MODE=fake MOONA_LEDGER=pglite`. It exits non-zero if `audit()` is non-empty.

## 13. Deferred (not in this work)

**Waiting on accounts the user does not have yet**
- A real login provider adapter (`AuthPort`) and account recovery.
- Real Stripe network calls and the Stripe CLI test-mode run: success, failure, cancel, forged redirect, bad signature, replay, delay, refund, concurrent use, cleared browser, cross-user access, budget-driven closing.
- The Supabase project, migrations, the `moona_app` password and the gated pg run.
- Calibrating real usage during the $10 testing window, and confirming the `usage.iterations` shape.

**Deployment**
- `vercel.json` Cron: `{ "crons": [{ "path": "/api/ops/reconcile", "schedule": "0 9 * * *" }] }` on Hobby, or a more frequent schedule on Pro.
- Public deployment and its URL.

**Features out of scope**
- An admin dashboard page.
- A server-side FIFO queue, provider RPM/ITPM pacing, lite mode, and an alert webhook or email.
- Automatic provider-billing reconciliation (it stays manual through `record-spend`).
- Streaming, prompt caching (the pricing already supports it), multi-currency, a tax engine and self-service refunds.
- Public social features and any user-to-user transfers.
- Removing the legacy file ledger.

## 14. Decisions for the user

1. **Models.** Which model for testing, demo and after (Sonnet 5.5, Haiku 4.5 or Opus 5.5), and whether server-side refusal fallbacks stay on. This sets the bounds, the pack allocation ($0.45 to $4.01) and whether 1000 calls fit in $35.
2. **AI credit.** Buy about $50 prepaid with auto-reload off. Use a dedicated key or workspace with the provider console spend limit set. Paste keys yourself. Report any spend already made so it can be recorded as `AI_PRIOR_SPEND_USD`.
3. **Database.** Supabase free tier (us-east-1, near Vercel iad1) or Neon. Create the project, run `ledger migrate --roles`, set the `moona_app` password, use the pooler URL, keep the project awake through Oct 28 (free projects pause when idle), and turn the spend cap on.
4. **Secrets.** Generate `SESSION_SECRET`, `OPS_TOKEN` and `CRON_SECRET` yourself, and decide who on the team holds `OPS_TOKEN` and resets the breaker on Demo Day.
5. **Budget split.** Confirm testing $10 / demo $35 / after $5 with no rollover. Decide whether to carve out a pack pool (for example demo $30 + packs $5 + $1 slack), and whether the $15/hour demo cap stays on (turn it off if the event is a single hour).
6. **Free access.** The free quota per visitor and window, whether Demo Day is open or behind the access code, and whether operator devices are quota-exempt (default yes).
7. **Buyer login.** Supabase Auth email OTP or magic link (needs a custom SMTP sender), Google, or a recovery code. Purchases stay disabled until you choose.
8. **Stripe.** Account, test keys, the $5 Price, webhook endpoint and secret, an honest business description (AI tarot and astrology service packs), live activation, tax, refund policy, terms, support contact, the dispute policy (revoke the remaining credits or keep them), and confirmation that the event allows on-site sales.
9. **Pack terms.** Price and contents, maximum live packs (10) and test packs (3), attempts and slack, and the fee assumption (4.4% + $0.30).
10. **Retention.** Free results kept 2 h and paid results 30 days, a deletion-request process, and approval of the new privacy copy.
11. **Hosting.** Vercel Pro ($20; required before any real sales), spend management set to pause, the Cron frequency and the public URL.
12. **Going live.** When to switch test to live, setting `PAYMENTS_LIVE_CONFIRM`, and running `revoke-mode-test` at that point.
13. **Licence.** Replace the Ether shader in `src/components/cosmos/shaders.ts`, scoped to that component, before setting `COMMERCIAL_ASSETS_CLEARED=1`.

## 15. Risks

- **Offline concurrency tests prove less than they appear.** PGlite serializes statements, so they prove per-call atomicity only. The design depends least on interleaving (one lock taken first, inside one statement), but the gated real-Postgres suite is mandatory before Oct 28.
- **Byte-based bounds overestimate tokens by 2–4x.** This shrinks concurrency headroom and the number of packs that fit. Calibration trades provability for capacity, and overruns trip the breaker.
- **Unknown billing (timeouts, 5xx) is charged at the full bound.** An outage can use up ledger budget that was never really spent. The cooldown limits this; corrections are manual entries.
- **Fail-closed means a database outage turns live AI off.** Supabase free has no SLA and pauses when idle. Offline readings, cards, journal and saved results keep working.
- **Clearing cookies resets free quota.** The damage is bounded by window, slice, mint and call caps and the access code. A script can drain the free pool, but never pack money.
- **Test packs spend real AI money when a real key is configured.** They are held like live packs, limited to operators, capped at 3, and revoked at go-live.
- **Stripe may refuse or restrict an AI tarot business.** First payouts are delayed, so revenue never funds the event and never raises the $100 cap.