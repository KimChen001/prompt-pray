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

/** Where and when an AI text was generated; shown so saved text is never presented as live. */
export interface AiMeta {
  provider: string;
  model: string;
  generatedAt: string; // ISO instant
  /** Prompt and claim-check versions the text was written and checked under (absent on older saves). */
  versions?: string;
  /** "simulated" = the offline fake provider (rehearsals): never shown as live AI. */
  source?: "live" | "simulated";
}

export interface TarotAiResult {
  cards: { position: number; insight: string }[];
  synthesis: string;
  action: string;
  reflection: string;
  meta: AiMeta;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  at: string; // ISO instant
  meta?: AiMeta; // assistant turns only
  /** User turns: the id of the AI request that answers this turn (a retry replays it for free). */
  requestId?: string;
  /** Assistant turns: a note MOONA offered to remember, from the person's own words. Saved only if they confirm. */
  suggestion?: { text: string; quote: string; status: "pending" | "saved" | "dismissed" };
  /** Assistant turns in free conversations: the context items the reply says it relied on (checked by the server). */
  basis?: BasisItem[];
}

/** One piece of context behind a reply: something the person said, or a calculated fact. */
export interface BasisItem {
  id: string;
  kind: "said" | "calc";
  label: string;
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
  /** User chose to add their Big Three to the AI interpretation. */
  includeChart?: boolean;
  /** AI interpretation per language, saved once generated (never regenerated silently). */
  ai?: Partial<Record<Locale, TarotAiResult>>;
  /** The request id of the AI interpretation per language, kept before sending so a retry or reload replays it for free. */
  aiRequest?: Partial<Record<Locale, string>>;
  /**
   * A pack reading the person chose for this spread (only by tapping "Use a pack reading"). Its request
   * id is kept before sending, so a retry or reload replays it and a credit is used once; after
   * success, the paid reading and its follow-ups left.
   */
  // sentAt: when the tap sent it; a "never made" answer soon after may only mean the tap's own request
  // (slow, or from another tab) hasn't reached the server yet
  paid?: { locale: Locale; requestId: string; sentAt?: string; paidReadingId?: string; followupsLeft?: number; followupsTotal?: number };
  /** Follow-up conversation about this reading. */
  thread?: ChatTurn[];
  /** Saved notes the person chose to share with the AI for this reading (ids into the note store). */
  noteIds?: string[];
}
