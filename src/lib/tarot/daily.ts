import { DECK } from "./deck";
import { rngFromSeed } from "./rng";
import type { DrawnCard, Topic } from "./types";

/**
 * Today's card for one device: stable for the same device, local day and topic, different
 * across devices. The caller stores the result, so later deck or algorithm changes never
 * change a card the user has already seen.
 */
export function dailyCard(deviceId: string, localDate: string, topic: Topic, allowReversed: boolean): DrawnCard {
  const rng = rngFromSeed(`daily|${deviceId}|${localDate}|${topic}`);
  const card = DECK[Math.floor(rng() * DECK.length)];
  const reversed = allowReversed && rng() < 0.5;
  return { id: card.id, reversed };
}
