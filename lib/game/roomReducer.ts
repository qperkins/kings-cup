import type { CardData } from "@/components/game/card-utils";
import { DECK_SIZE, isWildKing, type GameMode } from "../../components/game/wild-cards";
import {
  cardId,
  initialRoomState,
  type ChallengeType,
  type MatePair,
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

function parseMates(raw: unknown): MatePair[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is MatePair =>
      Array.isArray(m) &&
      m.length === 2 &&
      typeof m[0] === "string" &&
      typeof m[1] === "string",
  );
}

function parseChallenge(raw: unknown, fallback: ChallengeType): ChallengeType {
  return raw === "flip_cup" || raw === "bottle_flip" ? raw : fallback;
}

function parseGameMode(raw: unknown, fallback: GameMode): GameMode {
  return raw === "classic" || raw === "royal_mayhem" ? raw : fallback;
}

function parseDirection(raw: unknown, fallback: 1 | -1): 1 | -1 {
  return raw === 1 || raw === -1 ? raw : fallback;
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
  if (c.kind === "wild" && typeof c.wild_id === "string") {
    return {
      rank: "",
      suit: "",
      wildId: c.wild_id,
      id: cardId("wild", c.wild_id, drawCount),
    };
  }
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

  const gameMode = parseGameMode(sync.game_mode, state.gameMode);
  const deckSize = DECK_SIZE[gameMode];
  const cardsDrawn =
    typeof sync.cards_drawn === "number"
      ? sync.cards_drawn
      : deckSize - (sync.cards_remaining ?? state.cardsRemaining);

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
        ? deckSize
        : typeof sync.cards_remaining === "number"
          ? sync.cards_remaining
          : state.cardsRemaining,
    kingsDrawn:
      typeof sync.kings_drawn === "number" ? sync.kings_drawn : state.kingsDrawn,
    cardsDrawn,
    lastDrawnCard,
    lastCardRule,
    lastDrawnBy: null,
    quickFlipEnabled:
      typeof sync.quick_flip_enabled === "boolean"
        ? sync.quick_flip_enabled
        : state.quickFlipEnabled,
    challengeType: parseChallenge(sync.challenge_type, state.challengeType),
    hostId: typeof sync.host_id === "string" ? sync.host_id : state.hostId,
    rules: Array.isArray(sync.rules) ? sync.rules : [],
    bannedWords: Array.isArray(sync.banned_words) ? sync.banned_words : [],
    pendingInput: sync.pending_input ?? null,
    battle: sync.battle ?? null,
    mates: parseMates(sync.mates),
    gameMode,
    direction: parseDirection(sync.direction, 1),
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
        cardsRemaining: DECK_SIZE[state.gameMode],
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
        lastDrawnBy:
          typeof payload.player_id === "string" ? payload.player_id : null,
        drawSeq: state.drawSeq + 1,
        kingsDrawn:
          card && (card.rank === "K" || isWildKing(card.wildId))
            ? state.kingsDrawn + 1
            : state.kingsDrawn,
      };
    }

    case "settings_updated":
      return {
        ...state,
        quickFlipEnabled:
          typeof payload.quick_flip_enabled === "boolean"
            ? payload.quick_flip_enabled
            : state.quickFlipEnabled,
        challengeType: parseChallenge(payload.challenge_type, state.challengeType),
        gameMode: parseGameMode(payload.game_mode, state.gameMode),
      };

    case "players_reordered": {
      if (!Array.isArray(payload.players)) return state;
      const players = payload.players
        .map(parsePlayer)
        .filter((p): p is Player => p !== null)
        .sort((a, b) => a.seat - b.seat);
      return { ...state, players };
    }

    case "host_changed":
      return {
        ...state,
        hostId: typeof payload.host_id === "string" ? payload.host_id : state.hostId,
      };

    case "player_removed":
      // Carries a full client view (roster, host, turn, pending input, battle)
      // already repaired by the server, so re-apply it like a state_sync.
      return applyStateSync(state, payload);

    case "input_required":
      return {
        ...state,
        pendingInput:
          (payload.pending_input as RoomState["pendingInput"]) ?? null,
        battle: (payload.battle as RoomState["battle"]) ?? null,
      };

    case "rule_added":
      return {
        ...state,
        pendingInput: null,
        rules:
          typeof payload.text === "string"
            ? [...state.rules, payload.text]
            : state.rules,
      };

    case "word_banned":
      return {
        ...state,
        pendingInput: null,
        bannedWords:
          typeof payload.word === "string"
            ? [...state.bannedWords, payload.word]
            : state.bannedWords,
      };

    case "direction_changed":
      return { ...state, direction: parseDirection(payload.direction, state.direction) };

    case "mate_broken": {
      const [a, b] = [payload.a, payload.b];
      if (typeof a !== "string" || typeof b !== "string") return state;
      return {
        ...state,
        pendingInput: null,
        mates: state.mates.filter(
          ([x, y]) => !((x === a && y === b) || (x === b && y === a)),
        ),
        lastBroken: [a, b],
        brokenSeq: state.brokenSeq + 1,
      };
    }

    case "mate_chosen": {
      const [a, b] = [payload.player_id, payload.mate_id];
      if (typeof a !== "string" || typeof b !== "string") return state;
      const dup = state.mates.some(
        ([x, y]) => (x === a && y === b) || (x === b && y === a),
      );
      return {
        ...state,
        pendingInput: null,
        mates: dup ? state.mates : [...state.mates, [a, b]],
      };
    }

    case "battle_resolved":
      return { ...state, battle: null };

    case "returned_to_lobby":
    case "game_restarted":
      // Payload is a full client view; reuse state_sync handling (it resets
      // the pile, rules, banned words, pending input and battle).
      return applyStateSync(state, payload);

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
        pendingInput: null,
        battle: null,
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
