// Which payment mode this deployment is in (spec §7.3). Real charges ("live") need every
// precondition at once: live Stripe keys, an explicit PAYMENTS_LIVE_CONFIRM, a real account provider,
// the Postgres ledger, terms, refund policy and support contact, cleared commercial assets and an
// https site. Anything short of that is "misconfigured", which the public sees as "not enabled".
// No key is ever written by this code: the team pastes them into the host's environment.
import "server-only";
import { randomBytes } from "node:crypto";
import { isDeployed, type EnvLike } from "@/lib/host";

export type PaymentsState = "unconfigured" | "misconfigured" | "fake" | "test" | "live";

export interface PaymentsConfig {
  state: PaymentsState;
  /** What PAYMENTS_MODE asked for. */
  requested: string;
  /** Every failed precondition (shown to operators only). */
  problems: string[];
  /** Webhooks stay on in fake, test and live even while sales are closed, so refunds still land. */
  webhookEnabled: boolean;
  /**
   * Set when the payments are "misconfigured" only for selling (terms, assets, confirm, https...)
   * while the provider keys are sound: events for orders already taken are still processed.
   */
  webhookMode?: "test" | "live";
  secretKey?: string;
  webhookSecret?: string;
  priceId?: string;
  termsUrl?: string;
  refundUrl?: string;
  supportContact?: string;
  siteUrl: string;
}

/**
 * Whether reading packs are on here: sold (fake, test or live), or no longer sold while orders already
 * taken still settle. Only then is an account looked up for a visitor (so none is made elsewhere).
 */
export function packsOn(cfg: PaymentsConfig): boolean {
  return cfg.state === "fake" || cfg.state === "test" || cfg.state === "live" || !!cfg.webhookMode;
}

export type LedgerKindForPayments = "postgres" | "pglite" | "memory" | "file" | null;

/** A fixed secret for fake-mode webhooks under `next dev` (not a credential: nothing real is signed with it). */
export const DEV_FAKE_WEBHOOK_SECRET = "whsec_moona_fake_mode_local_only";
// A production server (even `next start` on a laptop) never uses the public one: fake deliveries are
// signed in-process, so a key made at start-up works and can't be forged from outside.
const PROCESS_FAKE_WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("base64url")}`;

export function paymentsConfig(env: EnvLike, ctx: { ledgerKind: LedgerKindForPayments; authKind: string }): PaymentsConfig {
  const requested = (env.PAYMENTS_MODE ?? "off").toLowerCase();
  const siteUrl = (env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const base = { requested, siteUrl, termsUrl: env.STORE_TERMS_URL || undefined, refundUrl: env.STORE_REFUND_POLICY_URL || undefined, supportContact: env.STORE_SUPPORT_CONTACT || undefined };
  if (requested === "off" || requested === "") return { ...base, state: "unconfigured", problems: [], webhookEnabled: false };
  const sql = ctx.ledgerKind === "postgres" || ctx.ledgerKind === "pglite" || ctx.ledgerKind === "memory";
  const problems: string[] = [];
  const fail = (state: "misconfigured") => ({ ...base, state, problems, webhookEnabled: false });

  if (requested === "fake") {
    if (isDeployed(env) && env.PAYMENTS_ALLOW_FAKE_ON_DEPLOY !== "1") problems.push("fake payments are not allowed on a deployment (PAYMENTS_ALLOW_FAKE_ON_DEPLOY=1 for a rehearsal preview)");
    if (!sql) problems.push("payments need the SQL ledger (MOONA_LEDGER postgres, pglite or memory)");
    const webhookSecret = env.FAKE_WEBHOOK_SECRET || (isDeployed(env) ? "" : env.NODE_ENV === "production" ? PROCESS_FAKE_WEBHOOK_SECRET : DEV_FAKE_WEBHOOK_SECRET);
    if (!webhookSecret) problems.push("FAKE_WEBHOOK_SECRET is required on a deployment");
    return problems.length ? fail("misconfigured") : { ...base, state: "fake", problems, webhookEnabled: true, webhookSecret };
  }

  if (requested !== "test" && requested !== "live") {
    problems.push(`PAYMENTS_MODE must be off, fake, test or live (got "${requested}")`);
    return fail("misconfigured");
  }
  const key = env.STRIPE_SECRET_KEY ?? "", secret = env.STRIPE_WEBHOOK_SECRET ?? "", price = env.STRIPE_PRICE_ID ?? "";
  const keyMode = /^(sk|rk)_test_/.test(key) ? "test" : /^(sk|rk)_live_/.test(key) ? "live" : null;
  if (keyMode !== requested) problems.push(keyMode ? `STRIPE_SECRET_KEY is a ${keyMode} key but PAYMENTS_MODE is ${requested}` : `STRIPE_SECRET_KEY must start with sk_${requested}_ or rk_${requested}_`);
  if (!secret.startsWith("whsec_")) problems.push("STRIPE_WEBHOOK_SECRET must start with whsec_");
  if (!price.startsWith("price_")) problems.push("STRIPE_PRICE_ID must start with price_");
  if (requested === "test" && !sql) problems.push("payments need the SQL ledger (MOONA_LEDGER postgres, pglite or memory)");
  // Whether provider events can be verified and applied at all; selling needs more (below).
  const webhookOk = problems.length === 0 && (requested === "live" ? ctx.ledgerKind === "postgres" : sql);
  if (requested === "live") {
    if (env.PAYMENTS_LIVE_CONFIRM !== "I_ACCEPT_REAL_CHARGES") problems.push("PAYMENTS_LIVE_CONFIRM must equal I_ACCEPT_REAL_CHARGES");
    if (ctx.authKind === "none" || ctx.authKind === "fake") problems.push("live payments need a real account provider (AUTH_PROVIDER)");
    if (ctx.ledgerKind !== "postgres") problems.push("live payments need the Postgres ledger");
    if (!base.termsUrl) problems.push("STORE_TERMS_URL is required");
    if (!base.refundUrl) problems.push("STORE_REFUND_POLICY_URL is required");
    if (!base.supportContact) problems.push("STORE_SUPPORT_CONTACT is required");
    if (env.COMMERCIAL_ASSETS_CLEARED !== "1") problems.push("COMMERCIAL_ASSETS_CLEARED must be 1 (every visual asset licensed for paid use)");
    if (!siteUrl.startsWith("https://")) problems.push("NEXT_PUBLIC_SITE_URL must be https");
  }
  if (problems.length) {
    // sales stay closed, but refunds and late payments for orders already taken still land
    return webhookOk ? { ...base, state: "misconfigured", problems, webhookEnabled: true, webhookMode: requested, secretKey: key, webhookSecret: secret, priceId: price } : fail("misconfigured");
  }
  return { ...base, state: requested, problems, webhookEnabled: true, secretKey: key, webhookSecret: secret, priceId: price };
}
