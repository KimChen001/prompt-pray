import majorA from "@content/tarot/major-a.json";
import majorB from "@content/tarot/major-b.json";
import wands from "@content/tarot/wands.json";
import cups from "@content/tarot/cups.json";
import swords from "@content/tarot/swords.json";
import pentacles from "@content/tarot/pentacles.json";
import type { CardData, Element, Suit } from "./types";

export const DECK: CardData[] = [majorA, majorB, wands, cups, swords, pentacles].flat() as CardData[];

const BY_ID = new Map(DECK.map((card) => [card.id, card]));

export function getCard(id: string): CardData {
  const card = BY_ID.get(id);
  if (!card) throw new Error(`Unknown card id: ${id}`);
  return card;
}

export function hasCard(id: string): boolean {
  return BY_ID.has(id);
}

export const CARD_BACK = "/cards/moona-back.svg"; // original MOONA artwork (content/credits.json)

export function cardImage(id: string): string {
  return `/cards/${id}.jpg`;
}

export const SUIT_ELEMENT: Record<Suit, Element> = {
  wands: "fire",
  cups: "water",
  swords: "air",
  pentacles: "earth",
};

export function elementOf(card: CardData): Element | null {
  return card.suit ? SUIT_ELEMENT[card.suit] : null;
}

const ROMAN = ["0", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX", "XXI"];

/** Short label for the mono metadata line, e.g. "XVIII" or "CUPS · 05". */
export function cardNumeral(card: CardData): string {
  if (card.arcana === "major") return ROMAN[card.number];
  return `${card.suit!.toUpperCase()} · ${String(card.number).padStart(2, "0")}`;
}
