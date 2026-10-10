// Everything a packs, webhook or operator route needs about this request, in one place: payment mode,
// ledger, operator status, account and the pack product. The plan (with its computed pack allocation)
// is resolved once per environment, not per request.
import "server-only";
import type { NextRequest } from "next/server";
import { aiConfig } from "@/lib/ai/config";
import { isDeployed, type EnvLike } from "@/lib/host";
import { authFromEnv, type AuthPort } from "@/lib/identity/auth";
import { serverKeys, type Keys } from "@/lib/identity/keys";
import { isOperator } from "@/lib/identity/ops";
import { readVisitor } from "@/lib/identity/visitor";
import { getLedger, ledgerKind } from "@/lib/ledger/factory";
import { resolvePlan, type ResolvedPlan } from "@/lib/ledger/plans";
import { LedgerUnavailable, type LedgerPort } from "@/lib/ledger/port";
import { paymentsConfig, type PaymentsConfig } from "./config";
import type { PaymentsPort } from "./port";
import { handleWebhook, paymentsFromConfig } from "./service";

let planCache: { key: string; plan: ResolvedPlan } | null = null;

/** The resolved plan for this environment (memoised: the pack allocation builds the largest prompts). */
export function currentPlan(env: EnvLike = process.env): ResolvedPlan {
  const key = Object.entries(env).filter(([k]) => /^(MOONA_PLAN|AI_|STORE_|PACK_|BUDGET_|FAKE_AI_PRICE_AS)/.test(k)).sort().map(([k, v]) => `${k}=${v}`).join("\n");
  if (planCache?.key !== key) planCache = { key, plan: resolvePlan(env, aiConfig(env)) };
  return planCache.plan;
}

export interface PacksContext {
  env: EnvLike;
  cfg: PaymentsConfig;
  keys: Keys | null;
  auth: AuthPort;
  operator: boolean;
  deployed: boolean;
  ledger: LedgerPort | null;
  pay: PaymentsPort | null;
  visitorId: string | null;
}

export async function packsContext(req: NextRequest, env: EnvLike = process.env): Promise<PacksContext> {
  const keys = serverKeys(env);
  const auth = authFromEnv(env);
  const cfg = paymentsConfig(env, { ledgerKind: ledgerKind(env), authKind: auth.kind });
  const got = await getLedger(env);
  const ledger = got.ok ? got.ledger : null;
  // fake deliveries go through the same webhook handler as a real provider's
  const pay: PaymentsPort | null = paymentsFromConfig(cfg, {
    sink: (raw, sig) => handleWebhook(raw, sig, { ledger: async () => { if (!ledger) throw new LedgerUnavailable("ledger_down"); return ledger; }, pay, cfg }),
  });
  return { env, cfg, keys, auth, operator: isOperator(req, keys), deployed: isDeployed(env), ledger, pay, visitorId: keys ? readVisitor(req, keys) : null };
}

export async function accountFor(req: NextRequest, c: PacksContext): Promise<string | null> {
  if (!c.ledger) return null;
  const a = await c.auth.getAccount(req, { visitorId: c.visitorId, ledger: c.ledger, isOperator: c.operator });
  return a?.accountId ?? null;
}
