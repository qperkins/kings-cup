import type { CardData } from "@/components/game/card-utils";
import type { GameState } from "@/components/game/GameBoard";

export type RoomPhase = "lobby" | "in_progress" | "finished";

export interface Player {
  id: string;
  name: string;
  seat: number;
  connected: boolean;
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
  connected: false,
  joining: true,
});

export function cardId(rank: string, suit: string, drawCount: number): string {
  return `${rank}-${suit}-${drawCount}`;
}

export function activePlayer(state: RoomState): Player | null {
  return state.players.find((p) => p.seat === state.currentTurnSeat) ?? null;
}

export function isHost(state: RoomState, playerId: string | null): boolean {
  if (!playerId || state.players.length === 0) return false;
  const sorted = [...state.players].sort((a, b) => a.seat - b.seat);
  return sorted[0]?.id === playerId;
}

/** Map reducer state to the GameBoard's existing GameState shape. */
export function toGameState(state: RoomState): GameState {
  const sorted = [...state.players].sort((a, b) => a.seat - b.seat);
  const turnOrder = sorted.map((p) => p.id);
  const playerNames = Object.fromEntries(sorted.map((p) => [p.id, p.name]));
  const hostId = sorted[0]?.id ?? null;
  const current = activePlayer(state);

  // Lobby deck is empty server-side; cards_remaining is meaningless until start.
  const cardsRemaining =
    state.phase === "lobby" ? 52 : state.cardsRemaining;
  const drawIndex = 52 - cardsRemaining;
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
      lobbySnapshot: { playerNames, hostId, players: turnOrder },
      drinksTakenTotal: 0,
      roomId: state.roomId,
    },
    currentPlayer: current
      ? { userId: current.id, name: current.name }
      : null,
    lastDrawnCard: state.lastDrawnCard,
    lastCardRule: state.lastCardRule,
  };
}
