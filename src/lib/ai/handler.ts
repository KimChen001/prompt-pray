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
import { serverKeys } from "@/lib/identity/keys";
import { ensureVisitor } from "@/lib/identity/visitor";
import { getLedger } from "@/lib/ledger/factory";
import type { LedgerPort } from "@/lib/ledger/port";
import type { EnvLike } from "@/lib/host";

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
  const subjectKey = `v:${visitor.id}`;
  const withCookie = (res: NextResponse) => {
    if (visitor.set) res.cookies.set({ name: visitor.set.name, value: visitor.set.value, ...visitor.set.options });
    return res;
  };
  if (ledger.kind === "file" && burstLimit(subjectKey)) return withCookie(NextResponse.json({ code: "rate_limited" }, { status: 429 }));

  const raw = body as { requestId?: unknown };
  const requestId = typeof raw?.requestId === "string" && REQUEST_ID.test(raw.requestId) ? raw.requestId : randomBytes(16).toString("base64url");
  const scope = spec.cacheScope?.(parsed) ?? "subject";
  const versions = spec.versions(parsed);
  const outcome = await meteredGenerate({
    ledger, cfg, keys, subjectKey, purpose: spec.purpose, mode: "free", requestId,
    req: spec.build(parsed), canonical: spec.canonical ? spec.canonical(parsed) : parsed, versions, validate: spec.validate(parsed),
    cacheScope: scope, resultTtlSeconds: scope === "shared" ? 93_600 : num(env.AI_RESULT_TTL_MIN, 120) * 60,
  }, deps);
  const value = outcome.kind === "fresh" || outcome.kind === "replayed" ? spec.respond(outcome.value as T, outcome.meta, parsed) : undefined;
  const level = outcome.kind === "fresh" ? levelFor(outcome.budgetRatio, env) : null;
  return withCookie(meterResponse(outcome, value, { budgetLevel: level }));
}
