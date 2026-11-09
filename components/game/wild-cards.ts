// Royal Mayhem "Court of Chaos" wildcards. Ids match WILD_RULES in game_engine/models.py.

export type GameMode = "classic" | "royal_mayhem";

export const DECK_SIZE: Record<GameMode, number> = { classic: 52, royal_mayhem: 64 };
/** How many Kings end the game (and trigger the King's Cup). */
export const KINGS_TO_END: Record<GameMode, number> = { classic: 4, royal_mayhem: 6 };

export const WILD_DRINK = "1 shot (or 3 drinks)";

export interface WildCardDef {
  id: string;
  name: string;
  emoji: string;
  /** Short line printed on the card. */
  tagline: string;
  /** Full rule shown under the table. */
  description: string;
}

export const WILD_CARDS: Record<string, WildCardDef> = {
  jester: {
    id: "jester",
    name: "Jester's Folly",
    emoji: "\u{1F921}",
    tagline: "Dare or drink",
    description: `The table picks a dare or an impression for the player who drew the card.
If they refuse, they take ${WILD_DRINK}.`,
  },
  reverse: {
    id: "reverse",
    name: "Reverse Decree",
    emoji: "\u{1F501}",
    tagline: "Turn order flips",
    description: `Turn order reverses and stays reversed until another Reverse Decree is drawn.
Play continues with the player who was just before the drawer.`,
  },
  exile: {
    id: "exile",
    name: "Exile",
    emoji: "\u{1F6AB}",
    tagline: "Next player skipped",
    description: `The next player is exiled: their turn is skipped, and they take ${WILD_DRINK}.`,
  },
  encore: {
    id: "encore",
    name: "Royal Encore",
    emoji: "\u{1F3AD}",
    tagline: "Draw again!",
    description: "The player who drew this card draws again right away.",
  },
  plague: {
    id: "plague",
    name: "Plague of Thirst",
    emoji: "\u{1F9A0}",
    tagline: "Everybody drinks",
    description: `Everyone at the table takes ${WILD_DRINK}.`,
  },
  pardon: {
    id: "pardon",
    name: "Royal Pardon",
    emoji: "\u{1F4DC}",
    tagline: "Get out of a drink",
    description: `The player who drew this card may cancel any one drink aimed at them, at any time.
Remember you hold it: use it once, then it's gone.`,
  },
  silence: {
    id: "silence",
    name: "Decree of Silence",
    emoji: "\u{1F910}",
    tagline: "Ban a gesture",
    description: `The player who drew this card names a banned gesture or word.
Anyone who does it takes ${WILD_DRINK}, until the drawer's next turn.`,
  },
  scepter: {
    id: "scepter",
    name: "Scepter Showdown",
    emoji: "\u{1FA84}",
    tagline: "Rock • Paper • Scissors",
    description: `The game picks a random player to face the drawer in rock-paper-scissors, best 2 out of 3.
The drawer reports the loser, who takes 3 drinks. There are no ties: keep playing until someone wins.`,
  },
  duel: {
    id: "duel",
    name: "Royal Duel",
    emoji: "⚔️",
    tagline: "Pick your rival",
    description: `The player who drew this card picks an opponent for a duel (the lobby's flip challenge, one attempt each).
The loser takes ${WILD_DRINK}.`,
  },
  treason: {
    id: "treason",
    name: "Treason",
    emoji: "\u{1F5E1}️",
    tagline: "Break a mate link",
    description: `The player who drew this card breaks any one drinking-mate pair.
Both ex-mates take ${WILD_DRINK}.
If nobody has mates yet, nothing happens.`,
  },
  king_chaos_a: {
    id: "king_chaos_a",
    name: "King of Chaos",
    emoji: "\u{1F451}",
    tagline: "Counts as a King",
    description: `Counts as a King toward the King's Cup. Pour some of your drink into the cup.
In Royal Mayhem the game ends when the 6th King (real or Chaos) is drawn.`,
  },
  king_chaos_b: {
    id: "king_chaos_b",
    name: "King of Chaos",
    emoji: "\u{1F451}",
    tagline: "Counts as a King",
    description: `Counts as a King toward the King's Cup. Pour some of your drink into the cup.
In Royal Mayhem the game ends when the 6th King (real or Chaos) is drawn.`,
  },
};

export function isWildKing(wildId: string | undefined): boolean {
  return wildId === "king_chaos_a" || wildId === "king_chaos_b";
}
