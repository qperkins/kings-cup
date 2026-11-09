import type { CardData } from "@/components/game/card-utils";
import type { GameState } from "@/components/game/GameBoard";
import { DECK_SIZE, type GameMode } from "../../components/game/wild-cards";

export type RoomPhase = "lobby" | "in_progress" | "finished";

export interface Player {
  id: string;
  name: string;
  seat: number;
  connected: boolean;
}

export interface PendingInput {
  player_id: string;
  kind: "rule" | "word_ban" | "mate" | "duel" | "treason";
}

/** [drawer_id, mate_id]. Order is not meaningful. */
export type MatePair = [string, string];

export type ChallengeType = "flip_cup" | "bottle_flip";

export interface Battle {
  challenger_id: string;
  opponent_id: string;
  challenge: ChallengeType;
  /** "challenge" = Queen's Quick Flip, "rps" = Scepter Showdown, "duel" = Royal Duel. */
  kind?: "challenge" | "rps" | "duel";
}

export interface StateSyncPayload {
  room_id: string;
  phase: RoomPhase;
  players: Player[];
  current_turn_seat: number;
  cards_remaining: number;
  kings_drawn: number;
  your_player_id: string;
  drawn_pile_top: { rank: string; suit: string; rule_text: string } | null;
  cards_drawn?: number;
  quick_flip_enabled?: boolean;
  challenge_type?: ChallengeType;
  host_id?: string | null;
  rules?: string[];
  banned_words?: string[];
  pending_input?: PendingInput | null;
  battle?: Battle | null;
  mates?: MatePair[];
  game_mode?: GameMode;
  direction?: 1 | -1;
}

export interface RoomState {
  roomId: string;
  phase: RoomPhase;
  players: Player[];
  currentTurnSeat: number;
  cardsRemaining: number;
  kingsDrawn: number;
  cardsDrawn: number;
  lastDrawnCard: CardData | null;
  lastCardRule: string | null;
  /** Player who drew lastDrawnCard (live events only; null after a sync). */
  lastDrawnBy: string | null;
  /** Bumped on every live card_drawn event; never by state_sync (no replayed popups). */
  drawSeq: number;
  quickFlipEnabled: boolean;
  challengeType: ChallengeType;
  hostId: string | null;
  rules: string[];
  bannedWords: string[];
  pendingInput: PendingInput | null;
  battle: Battle | null;
  mates: MatePair[];
  /** Last pair broken by Treason + a counter bumped per live mate_broken (never by state_sync). */
  lastBroken: MatePair | null;
  brokenSeq: number;
  gameMode: GameMode;
  /** 1 = normal turn order, -1 = reversed by a Reverse Decree. */
  direction: 1 | -1;
  connected: boolean;
  joining: boolean;
}

export const initialRoomState = (roomId: string): RoomState => ({
  roomId,
  phase: "lobby",
  players: [],
  currentTurnSeat: 0,
  cardsRemaining: 52,
  kingsDrawn: 0,
  cardsDrawn: 0,
  lastDrawnCard: null,
  lastCardRule: null,
  lastDrawnBy: null,
  drawSeq: 0,
  quickFlipEnabled: true,
  challengeType: "flip_cup",
  hostId: null,
  rules: [],
  bannedWords: [],
  pendingInput: null,
  battle: null,
  mates: [],
  lastBroken: null,
  brokenSeq: 0,
  gameMode: "classic",
  direction: 1,
  connected: false,
  joining: true,
});

export function cardId(rank: string, suit: string, drawCount: number): string {
  return `${rank}-${suit}-${drawCount}`;
}

export function activePlayer(state: RoomState): Player | null {
  return state.players.find((p) => p.seat === state.currentTurnSeat) ?? null;
}

/** The host is whoever the server says (host_id); lowest seat only as a fallback. */
export function hostIdOf(state: RoomState): string | null {
  if (state.hostId && state.players.some((p) => p.id === state.hostId)) {
    return state.hostId;
  }
  const sorted = [...state.players].sort((a, b) => a.seat - b.seat);
  return sorted[0]?.id ?? null;
}

export function isHost(state: RoomState, playerId: string | null): boolean {
  if (!playerId || state.players.length === 0) return false;
  return hostIdOf(state) === playerId;
}

/** Map reducer state to the GameBoard's existing GameState shape. */
export function toGameState(state: RoomState): GameState {
  const sorted = [...state.players].sort((a, b) => a.seat - b.seat);
  const turnOrder = sorted.map((p) => p.id);
  const playerNames = Object.fromEntries(sorted.map((p) => [p.id, p.name]));
  const hostId = hostIdOf(state);
  const current = activePlayer(state);

  // Lobby deck is empty server-side; cards_remaining is meaningless until start.
  const deckSize = DECK_SIZE[state.gameMode];
  const cardsRemaining =
    state.phase === "lobby" ? deckSize : state.cardsRemaining;
  const drawIndex = deckSize - cardsRemaining;
  return {
    game: {
      phase: state.phase,
      deck: [],
      drawIndex,
      discard: state.lastDrawnCard ? [state.lastDrawnCard] : [],
      kingsDrawn: state.kingsDrawn,
      turnOrder,
      turnIndex: state.currentTurnSeat,
      roundNumber: 1,
      rules: { version: "kingscup_v1", byRank: {} },
      lobbySnapshot: { playerNames, hostId: hostId ?? undefined, players: turnOrder },
      drinksTakenTotal: 0,
      roomId: state.roomId,
    },
    currentPlayer: current
      ? { userId: current.id, name: current.name }
      : null,
    lastDrawnCard: state.lastDrawnCard,
    lastCardRule: state.lastCardRule,
    lastDrawnBy: state.lastDrawnBy,
    drawSeq: state.drawSeq,
    quickFlipEnabled: state.quickFlipEnabled,
    challengeType: state.challengeType,
    rules: state.rules,
    bannedWords: state.bannedWords,
    pendingInput: state.pendingInput,
    battle: state.battle,
    mates: state.mates,
    lastBroken: state.lastBroken,
    brokenSeq: state.brokenSeq,
    gameMode: state.gameMode,
    direction: state.direction,
  };
}
