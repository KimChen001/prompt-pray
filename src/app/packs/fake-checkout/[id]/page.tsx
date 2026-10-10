import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { isDeployed } from "@/lib/host";
import { authFromEnv } from "@/lib/identity/auth";
import { serverKeys } from "@/lib/identity/keys";
import { OPS_COOKIE, verifyOpsCookie } from "@/lib/identity/ops";
import { ledgerKind } from "@/lib/ledger/factory";
import { paymentsConfig } from "@/lib/payments/config";
import { FakeCheckout } from "./FakeCheckout";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// DEV/REHEARSAL ONLY: the checkout page of fake payments. It exists only in fake mode, and on a
// deployment only for operator devices; everywhere else it is a plain 404.
export default async function FakeCheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cfg = paymentsConfig(process.env, { ledgerKind: ledgerKind(), authKind: authFromEnv().kind });
  const keys = serverKeys();
  const operator = !!keys && verifyOpsCookie((await cookies()).get(OPS_COOKIE)?.value, keys);
  if (cfg.state !== "fake" || !UUID.test(id) || (isDeployed() && !operator)) notFound();
  return <FakeCheckout orderId={id} />;
}
