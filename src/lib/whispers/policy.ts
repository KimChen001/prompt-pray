// Whispers. What exists today: private writing, kept only on this device. The shared wall is part of
// the full scope but needs a server, moderation and product decisions (see WALL_DECISIONS); until
// those exist nothing is posted anywhere and no posts or counts are shown.
// This module is the agreed groundwork both sides will use: what a shared post may contain.
import { detectCrisis } from "@/lib/safety";

export const PRIVATE_MAX = 2000;
export const WALL_MAX = 280;

export type WallCheck =
  | { ok: true; text: string }
  | { ok: false; reason: "empty" | "too_long" | "link" | "contact" | "crisis" };

const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|io|cn|me|app|co|xyz)\b/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+?\d[\s-]?){7,}/;
const HANDLE = /(^|\s)@\w{3,}/;

/** Rules for a post on the future shared wall: short, no links, no ways to identify or contact anyone. */
export function checkWallPost(raw: string): WallCheck {
  const text = raw.normalize("NFKC").trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > WALL_MAX) return { ok: false, reason: "too_long" };
  // Crisis language is never posted; the writer is shown support resources instead.
  if (detectCrisis(text)) return { ok: false, reason: "crisis" };
  if (LINK.test(text)) return { ok: false, reason: "link" };
  if (EMAIL.test(text) || PHONE.test(text) || HANDLE.test(text)) return { ok: false, reason: "contact" };
  return { ok: true, text };
}

/** Product decisions the shared wall still needs (from the product discussion, §5 and §10.5). */
export const WALL_DECISIONS = ["visibility", "replies", "moderation", "retention", "stats", "age"] as const;
export type WallDecision = (typeof WALL_DECISIONS)[number];
