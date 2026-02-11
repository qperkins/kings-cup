// ---------------------------------------------------------------------------
// Card data types and SVG-sprite helpers
// ---------------------------------------------------------------------------

/** Shape of a card object as stored in the Convex game state. */
export type CardData = {
  id: string;
  rank: string;
  suit: string;
};

// Natural dimensions of each card inside svg-cards.svg
export const CARD_WIDTH = 169.075;
export const CARD_HEIGHT = 244.64;
export const CARD_VIEWBOX = `0 0 ${CARD_WIDTH} ${CARD_HEIGHT}`;

// Spring config recommended by agents.md
export const CARD_SPRING = { type: "spring" as const, stiffness: 300, damping: 30 };

// ---------------------------------------------------------------------------
// Backend ID  →  SVG sprite ID
// ---------------------------------------------------------------------------
// Backend uses:  rank = "A"|"2"…"10"|"J"|"Q"|"K", suit = "hearts"|"diamonds"|"clubs"|"spades"
// SVG sprite:    {suit_singular}_{rankValue}  e.g.  heart_1, spade_king

const SUIT_TO_SPRITE: Record<string, string> = {
  hearts: "heart",
  diamonds: "diamond",
  clubs: "club",
  spades: "spade",
};

const RANK_TO_SPRITE: Record<string, string> = {
  A: "1",
  J: "jack",
  Q: "queen",
  K: "king",
};

/**
 * Map a backend card's rank + suit to the SVG-cards sprite `<use>` fragment ID.
 *
 * @example getCardSpriteId("A", "hearts")  // "heart_1"
 * @example getCardSpriteId("K", "spades")  // "spade_king"
 * @example getCardSpriteId("10", "clubs")  // "club_10"
 */
export function getCardSpriteId(rank: string, suit: string): string {
  const spriteSuit = SUIT_TO_SPRITE[suit] ?? suit;
  const spriteRank = RANK_TO_SPRITE[rank] ?? rank;
  return `${spriteSuit}_${spriteRank}`;
}

/** Full href for a `<use>` element inside an inline `<svg>`. */
export function getCardHref(rank: string, suit: string): string {
  return `/cards/svg-cards.svg#${getCardSpriteId(rank, suit)}`;
}

/** Href for the simplified card back. */
export const CARD_BACK_HREF = "/cards/svg-cards.svg#alternate-back";

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const SUIT_SYMBOLS: Record<string, string> = {
  hearts: "\u2665",
  diamonds: "\u2666",
  clubs: "\u2663",
  spades: "\u2660",
};

const SUIT_COLORS: Record<string, string> = {
  hearts: "text-red-500",
  diamonds: "text-red-500",
  clubs: "text-white",
  spades: "text-white",
};

/** Unicode suit symbol (e.g. ♥) */
export function suitSymbol(suit: string): string {
  return SUIT_SYMBOLS[suit] ?? suit;
}

/** Tailwind color class for a suit */
export function suitColorClass(suit: string): string {
  return SUIT_COLORS[suit] ?? "text-white";
}

/** Human-readable rank label (e.g. "Ace", "Jack", "10") */
export function rankLabel(rank: string): string {
  switch (rank) {
    case "A":
      return "Ace";
    case "J":
      return "Jack";
    case "Q":
      return "Queen";
    case "K":
      return "King";
    default:
      return rank;
  }
}
