export type Locale = "en" | "zh";
export type L10n = Record<Locale, string>;
export type L10nList = Record<Locale, string[]>;

export type Suit = "wands" | "cups" | "swords" | "pentacles";
export type Element = "fire" | "water" | "air" | "earth";
export type Topic = "general" | "love" | "work" | "growth";
export type SpreadId = "single" | "triad" | "relate" | "choice";

export interface CardSide {
  keywords: L10nList;
  meaning: L10n;
  advice: L10n;
  love: L10n;
  work: L10n;
  growth: L10n;
}

export interface CardData {
  id: string;
  arcana: "major" | "minor";
  suit: Suit | null;
  number: number;
  name: L10n;
  description: L10n;
  upright: CardSide;
  reversed: CardSide;
}

export interface DrawnCard {
  id: string;
  reversed: boolean;
}

export interface Reading {
  id: string;
  kind: "reading" | "daily";
  createdAt: string; // UTC instant (ISO)
  localDate: string; // user's calendar day, YYYY-MM-DD
  spread: SpreadId;
  topic: Topic;
  question?: string;
  cards: DrawnCard[]; // in position order
  seed: string;
}
