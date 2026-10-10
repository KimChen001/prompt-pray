// Buyer accounts (spec §3.2 auth). A pack's credits must survive a cleared browser, so buying needs
// a real account; which provider that is has not been decided by the team yet (recorded as a user
// decision). Until then:
//   none (default): nobody can buy; the packs page says sign-in isn't available yet.
//   fake: a test account tied to this browser's visitor id, only off deployments or for operators.
//         The UI says so plainly. It exists so the whole paid path can be rehearsed offline.
import "server-only";
import type { NextRequest } from "next/server";
import { isDeployed, type EnvLike } from "@/lib/host";
import type { LedgerPort } from "@/lib/ledger/port";

export interface AuthPort {
  kind: string;
  /** Whether accounts can exist at all for this caller. */
  ready(ctx: { isOperator: boolean }): boolean;
  getAccount(req: NextRequest, ctx: { visitorId: string | null; ledger: LedgerPort; isOperator: boolean }): Promise<{ accountId: string } | null>;
}

export function authFromEnv(env: EnvLike = process.env): AuthPort {
  const kind = (env.AUTH_PROVIDER ?? "none").toLowerCase();
  if (kind === "fake") {
    const ready = (ctx: { isOperator: boolean }) => !isDeployed(env) || ctx.isOperator;
    return {
      kind: "fake",
      ready,
      async getAccount(_req, ctx) {
        if (!ready(ctx) || !ctx.visitorId || !ctx.ledger.supportsPaid) return null;
        return { accountId: await ctx.ledger.ensureAccount("fake", ctx.visitorId) };
      },
    };
  }
  // "none", and any provider name this build doesn't implement yet: no accounts
  return { kind: kind === "none" ? "none" : kind, ready: () => false, getAccount: async () => null };
}
