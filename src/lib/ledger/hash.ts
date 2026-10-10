// Keyed hashes for the ledger (spec §3.3). Inputs are HMAC'd with a server key, so the database
// never holds a question or reading in a reversible form; the client's request id is bound to the
// subject and purpose so it can't collide across people.
import "server-only";
import { createHmac } from "node:crypto";
import type { Purpose } from "@/lib/ai/types";

/** JSON with sorted keys and undefined dropped: the same value always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  const withJson = v as { toJSON?: () => unknown };
  if (typeof withJson.toJSON === "function") return canonicalJson(withJson.toJSON()); // Dates hash by their value
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export function inputHash(k: Buffer, x: unknown): string {
  return createHmac("sha256", k).update(canonicalJson(x)).digest("hex");
}

export function idemKey(k: Buffer, subjectKey: string, purpose: Purpose, requestId: string): string {
  return createHmac("sha256", k).update(`idem|${subjectKey}|${purpose}|${requestId}`).digest("hex");
}

/**
 * Identifies one draw for one account: the saved reading's own random id (never its content), so the
 * same draw gets one pack reading however it is asked for, and a new draw of the same cards is new.
 */
export function drawKey(k: Buffer, accountId: string, drawId: string): string {
  return createHmac("sha256", k).update(`draw|${accountId}|${drawId}`).digest("hex");
}

/** Identifies one tarot reading (not its language), so a paid follow-up can only be about that reading. */
export function readingHash(k: Buffer, r: { spread: string; topic: string; question?: string; cards: { id: string; reversed: boolean }[] }): string {
  return createHmac("sha256", k).update(`reading|${canonicalJson({ spread: r.spread, topic: r.topic, question: r.question ?? "", cards: r.cards.map((c) => ({ id: c.id, reversed: c.reversed })) })}`).digest("hex");
}
