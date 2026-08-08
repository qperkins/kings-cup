import type { CardData } from "@/components/game/card-utils";
import {
  cardId,
  initialRoomState,
  type Player,
  type RoomPhase,
  type RoomState,
  type StateSyncPayload,
} from "./types";

export type ServerEventPayload = Record<string, unknown>;

function parsePlayer(raw: unknown): Player | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || typeof p.name !== "string") return null;
  return {
    id: p.id,
    name: p.name,
    seat: typeof p.seat === "number" ? p.seat : 0,
    connected: p.connected !== false,
  };
}

function parsePhase(raw: unknown): RoomPhase {
  if (raw === "in_progress" || raw === "finished" || raw === "lobby") {
    return raw;
  }
  return "lobby";
}

function parseCard(raw: unknown, drawCount: number): CardData | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.rank !== "string" || typeof c.suit !== "string") return null;
  return {
    rank: c.rank,
    suit: c.suit,
    id: cardId(c.rank, c.suit, drawCount),
  };
}

function upsertPlayer(players: Player[], player: Player): Player[] {
  const idx = players.findIndex((p) => p.id === player.id);
  if (idx === -1) return [...players, player].sort((a, b) => a.seat - b.seat);
  const next = [...players];
  next[idx] = { ...next[idx], ...player };
  return next.sort((a, b) => a.seat - b.seat);
}

export function applyStateSync(
  state: RoomState,
  payload: ServerEventPayload,
): RoomState {
  const sync = payload as unknown as StateSyncPayload;
  const players = Array.isArray(sync.players)
    ? sync.players
        .map(parsePlayer)
        .filter((p): p is Player => p !== null)
    : state.players;

  const cardsDrawn =
    typeof sync.cards_drawn === "number"
      ? sync.cards_drawn
      : 52 - (sync.cards_remaining ?? state.cardsRemaining);

  let lastDrawnCard: CardData | null = null;
  let lastCardRule: string | null = null;

  if (sync.drawn_pile_top && typeof sync.drawn_pile_top === "object") {
    const top = sync.drawn_pile_top;
    const card = parseCard(top, cardsDrawn);
    if (card) lastDrawnCard = card;
    if (typeof top.rule_text === "string") lastCardRule = top.rule_text;
  }

  return {
    ...state,
    roomId: typeof sync.room_id === "string" ? sync.room_id : state.roomId,
    phase: parsePhase(sync.phase),
    players,
    currentTurnSeat:
      typeof sync.current_turn_seat === "number"
        ? sync.current_turn_seat
        : state.currentTurnSeat,
    cardsRemaining:
      parsePhase(sync.phase) === "lobby"
        ? 52
        : typeof sync.cards_remaining === "number"
          ? sync.cards_remaining
          : state.cardsRemaining,
    kingsDrawn:
      typeof sync.kings_drawn === "number" ? sync.kings_drawn : state.kingsDrawn,
    cardsDrawn,
    lastDrawnCard,
    lastCardRule,
    joining: false,
  };
}

export function reduceRoomEvent(
  state: RoomState,
  eventType: string,
  payload: ServerEventPayload,
): RoomState {
  switch (eventType) {
    case "state_sync":
      return applyStateSync(state, payload);

    case "player_joined": {
      const player = parsePlayer(payload);
      if (!player) return state;
      return {
        ...state,
        players: upsertPlayer(state.players, player),
        joining: false,
      };
    }

    case "player_reconnected": {
      const player = parsePlayer(payload);
      if (!player) return state;
      return {
        ...state,
        players: upsertPlayer(state.players, { ...player, connected: true }),
        joining: false,
      };
    }

    case "game_started":
      return {
        ...state,
        phase: "in_progress",
        cardsRemaining: 52,
        joining: false,
      };

    case "card_drawn": {
      const drawCount = state.cardsDrawn + 1;
      const card = parseCard(payload.card, drawCount);
      const cardsRemaining =
        typeof payload.cards_remaining === "number"
          ? payload.cards_remaining
          : Math.max(0, state.cardsRemaining - 1);

      return {
        ...state,
        cardsDrawn: drawCount,
        cardsRemaining,
        lastDrawnCard: card,
        lastCardRule:
          typeof payload.rule_text === "string" ? payload.rule_text : null,
        kingsDrawn:
          card?.rank === "K" ? state.kingsDrawn + 1 : state.kingsDrawn,
      };
    }

    case "turn_advanced":
      return {
        ...state,
        currentTurnSeat:
          typeof payload.current_turn_seat === "number"
            ? payload.current_turn_seat
            : state.currentTurnSeat,
      };

    case "game_finished":
      return {
        ...state,
        phase: "finished",
        kingsDrawn:
          typeof payload.kings_drawn === "number"
            ? payload.kings_drawn
            : state.kingsDrawn,
      };

    default:
      return state;
  }
}

export { initialRoomState };
