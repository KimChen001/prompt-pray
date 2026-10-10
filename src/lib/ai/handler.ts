// The shared body of the five AI routes (spec §8.1). Order: access → parse → preflight (crisis, bad
// facts: nothing reserved) → ledger → visitor → burst limit (file ledger) → metered generation →
// response, with Set-Cookie when a visitor was minted. A route only describes its request: how to
// parse it, build the prompt, validate the reply and shape the response.
import "server-only";
import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { aiConfig, type AiConfig } from "./config";
import { burstLimit, checkAiAccess } from "./guard";
import { meterResponse } from "./http";
import { meteredGenerate, type MeterDeps } from "./meter";
import type { JsonRequest, PublicMeta, Purpose } from "./types";
import { authFromEnv } from "@/lib/identity/auth";
import { serverKeys, type Keys } from "@/lib/identity/keys";
import { isOperator } from "@/lib/identity/ops";
import { ensureVisitor } from "@/lib/identity/visitor";
import { getLedger, ledgerKind } from "@/lib/ledger/factory";
import { LedgerUnavailable, type LedgerPort, type ReqMode } from "@/lib/ledger/port";
import type { EnvLike } from "@/lib/host";
import { packsOn, paymentsConfig } from "@/lib/payments/config";

export interface AiRouteSpec<P, T> {
  purpose: Purpose;
  parse(body: unknown): P | null;
  /** Crisis or bad facts: answered before any ledger call, so nothing is reserved. */
  preflight?(p: P): NextResponse | null;
  build(p: P): Omit<JsonRequest, "maxOutputTokens">;
  validate(p: P): (d: unknown) => T | null;
  versions(p: P): string;
  respond(value: T, meta: PublicMeta, p: P): Record<string, unknown>;
  cacheScope?(p: P): "subject" | "shared";
  /** What identifies the request for replay and caching (default: the parsed request). */
  canonical?(p: P): unknown;
  /** A paid request (a pack reading or follow-up), never assumed: only when the body asks for it. */
  paid?(body: Record<string, unknown>, p: P, keys: Keys): { mode: "paid_reading" | "paid_followup"; readingHash: string; paidReadingId?: string } | null;
}

export interface HandlerDeps extends MeterDeps {
  ledger?: LedgerPort;
  cfg?: AiConfig;
  env?: EnvLike;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** The level a budget ratio reaches against AI_WARN_AT, or null below the first line. */
export function levelFor(ratio: number | undefined, env: EnvLike = process.env): "notice" | "warn" | "critical" | null {
  if (ratio === undefined) return null;
  const w = (env.AI_WARN_AT ?? "").split(",").map(Number);
  const [a, b, c] = w.length === 3 && w.every(Number.isFinite) ? w : [0.5, 0.8, 0.95];
  return ratio >= c ? "critical" : ratio >= b ? "warn" : ratio >= a ? "notice" : null;
}

export async function handleAi<P, T>(req: NextRequest, spec: AiRouteSpec<P, T>, deps: HandlerDeps = {}): Promise<NextResponse> {
  const env = deps.env ?? process.env;
  const cfg = deps.cfg ?? aiConfig(env);
  const denied = checkAiAccess(req, env);
  if (denied) return NextResponse.json({ code: denied }, { status: 503 });
  const body: unknown = await req.json().catch(() => null);
  const parsed = spec.parse(body);
  if (parsed === null) return NextResponse.json({ code: "bad_request" }, { status: 400 });
  const pre = spec.preflight?.(parsed);
  if (pre) return pre;

  const keys = serverKeys(env);
  if (!keys) return NextResponse.json({ code: "misconfigured" }, { status: 503 });
  let ledger = deps.ledger;
  if (!ledger) {
    const got = await getLedger(env);
    if (!got.ok) return NextResponse.json({ code: "ledger" }, { status: 503 });
    ledger = got.ledger;
  }
  let visitor;
  try {
    visitor = await ensureVisitor(req, ledger, keys);
  } catch {
    return NextResponse.json({ code: "ledger" }, { status: 503 });
  }
  if ("denied" in visitor) {
    return visitor.denied === "plan_unsynced"
      ? NextResponse.json({ code: "unconfigured" }, { status: 503 })
      : NextResponse.json({ code: "visitor_cap" }, { status: 429 });
  }
  const withCookie = (res: NextResponse) => {
    if (visitor.set) res.cookies.set({ name: visitor.set.name, value: visitor.set.value, ...visitor.set.options });
    return res;
  };
  const operator = isOperator(req, keys);
  const auth = authFromEnv(env);
  const raw = (body ?? {}) as Record<string, unknown>;

  // Free requests count against this visitor; a paid one is drawn from the account's pack.
  const paid = spec.paid?.(raw, parsed, keys) ?? null;
  let subjectKey = `v:${visitor.id}`, accountId: string | undefined, mode: ReqMode = "free";
  if (paid) {
    let account;
    try {
      account = ledger.supportsPaid ? await auth.getAccount(req, { visitorId: visitor.id, ledger, isOperator: operator }) : null;
    } catch (e) {
      if (e instanceof LedgerUnavailable) return withCookie(NextResponse.json({ code: "ledger" }, { status: 503 }));
      throw e;
    }
    if (!account) return withCookie(NextResponse.json({ code: "login_required" }, { status: 401 }));
    subjectKey = `a:${account.accountId}`;
    accountId = account.accountId;
    mode = paid.mode;
  }
  if (ledger.kind === "file" && burstLimit(subjectKey)) return withCookie(NextResponse.json({ code: "rate_limited" }, { status: 429 }));

  const requestId = typeof raw.requestId === "string" && REQUEST_ID.test(raw.requestId) ? raw.requestId : randomBytes(16).toString("base64url");
  const scope = paid ? "subject" : spec.cacheScope?.(parsed) ?? "subject";
  const ttl = paid ? num(env.PAID_RESULT_TTL_DAYS, 30) * 86_400 : scope === "shared" ? 93_600 : num(env.AI_RESULT_TTL_MIN, 120) * 60;
  const outcome = await meteredGenerate({
    ledger, cfg, keys, subjectKey, accountId, purpose: spec.purpose, mode, requestId,
    quotaExempt: !paid && operator && env.AI_OPERATOR_QUOTA_EXEMPT !== "0",
    req: spec.build(parsed), canonical: spec.canonical ? spec.canonical(parsed) : parsed, versions: spec.versions(parsed), validate: spec.validate(parsed),
    cacheScope: scope, resultTtlSeconds: ttl, ...(paid ? { paid: { readingHash: paid.readingHash, paidReadingId: paid.paidReadingId }, replayOnly: raw.replayOnly === true } : {}),
  }, deps);
  const value = outcome.kind === "fresh" || outcome.kind === "replayed" ? spec.respond(outcome.value as T, outcome.meta, parsed) : undefined;
  const level = outcome.kind === "fresh" ? levelFor(outcome.budgetRatio, env) : null;
  // Out of free readings: say how many pack credits this browser's account has, so the page can offer
  // one. Only where reading packs are on (or were, and orders still settle): elsewhere no account is
  // looked up, so none is ever made for a free visitor.
  let credits: number | null = null;
  const quota = outcome.kind === "denied" && outcome.reason === "subject_quota";
  if (quota && packsOn(paymentsConfig(env, { ledgerKind: ledgerKind(env), authKind: auth.kind })) && ledger.supportsPaid && auth.ready({ isOperator: operator })) {
    try {
      const account = await auth.getAccount(req, { visitorId: visitor.id, ledger, isOperator: operator });
      if (account) credits = (await ledger.entitlements(account.accountId)).credits;
    } catch {
      credits = null;
    }
  }
  return withCookie(meterResponse(outcome, value, { budgetLevel: level, credits }));
}
