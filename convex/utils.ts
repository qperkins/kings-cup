// Validation utils
export const MAX_PLAYER_NAME_LENGTH = 24;
type GraphemeSegmenter = {
  segment: (input: string) => Iterable<{ segment: string }>;
};

const createNameSegmenter = (): GraphemeSegmenter | null => {
  if (typeof Intl === "undefined") {
    return null;
  }
  const SegmenterCtor = (
    Intl as {
      Segmenter?: new (...args: unknown[]) => GraphemeSegmenter;
    }
  ).Segmenter;
  return SegmenterCtor
    ? new SegmenterCtor("en", { granularity: "grapheme" })
    : null;
};

const nameSegmenter = createNameSegmenter();

const getPlayerNameLength = (value: string) =>
  nameSegmenter
    ? Array.from(nameSegmenter.segment(value)).length
    : Array.from(value).length;

export const normalizePlayers = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((player): player is string => typeof player === "string")
    : [];

export const normalizePlayerNames = (
  value: unknown,
): Partial<Record<string, string>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value).filter(
    ([, playerName]) => typeof playerName === "string",
  );
  return Object.fromEntries(entries);
};

export const normalizePlayerName = (value: string) => {
  const name = value.trim();
  if (name.length === 0) {
    throw new Error("Player name is required");
  }
  if (getPlayerNameLength(name) > MAX_PLAYER_NAME_LENGTH) {
    throw new Error(
      `Player name must be ${MAX_PLAYER_NAME_LENGTH} characters or fewer`,
    );
  }
  return name;
};

// Game logic utils
type Card = {
  id: string;
  rank: string;
  suit: string;
};

const SUITS = ["hearts", "diamonds", "clubs", "spades"] as const;
const RANKS = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
] as const;

const buildDeck = (): Card[] =>
  SUITS.flatMap((suit) =>
    RANKS.map((rank) => ({
      id: `${rank}_${suit}`,
      rank,
      suit,
    })),
  );

const fnv1a32 = (input: string): number => {
  // Deterministic, fast string hash for seeded shuffles since we can't use Math.random()
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const mulberry32 = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
};

export const shuffleWithSeed = <T>(items: readonly T[], seed: string): T[] => {
  const result = [...items];
  const random = mulberry32(fnv1a32(seed));
  for (let i = result.length - 1; i > 0; i -= 1) {
    const swapIndex = Math.floor(random() * (i + 1));
    [result[i], result[swapIndex]] = [result[swapIndex], result[i]];
  }
  return result;
};

export const buildShuffledDeck = (seed: string): Card[] =>
  shuffleWithSeed(buildDeck(), `deck:${seed}`);
