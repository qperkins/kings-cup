import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { buildGameStateContext } from "./logging";
import {
  buildShuffledDeck,
  normalizePlayerNames,
  normalizePlayers,
  shuffleWithSeed,
} from "./utils";

const DEFAULT_KINGS_CUP_RULES = {
  version: "kingscup_v1",
  byRank: {
    A: "Waterfall",
    "2": "You",
    "3": "Me",
    "4": "Floor",
    "5": "Guys",
    "6": "Chicks",
    "7": "Heaven",
    "8": "Mate",
    "9": "Rhyme",
    "10": "Categories",
    J: "Never Have I Ever",
    Q: "Questions",
    K: "King's Cup",
  },
} as const;

export const startGame = mutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    // Validate + snapshot + create game state + emit event (atomic mutation).
    const room = await ctx.db
      .query("rooms")
      .filter((q) => q.eq(q.field("roomID"), args.roomId))
      .first();
    const gameStateContext = buildGameStateContext({
      session_id: args.roomId,
      player_id: args.userId,
    });

    if (!room) {
      console.info({
        event: "game_start",
        outcome: "room_not_found",
        invalid_move_reason: "room_not_found",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Room not found", code: "ROOM_404" });
    }

    const roomCode = (room.roomID ?? args.roomId) as string;
    const players = normalizePlayers(room.players);
    const playerNames = normalizePlayerNames(room.playerNames);
    const hostId = players[0] ?? null;

    gameStateContext.session_id = roomCode;
    gameStateContext.total_players = players.length;
    gameStateContext.players_remaining = players.length;
    gameStateContext.is_host = hostId === args.userId;

    // 1) Validate
    if (!hostId || hostId !== args.userId) {
      console.info({
        event: "game_start",
        outcome: "not_host",
        invalid_move_reason: "not_host",
        ...gameStateContext,
      });
      throw new ConvexError({
        message: "Only the host can start the game",
        code: "GAME_NOT_HOST",
      });
    }

    if (players.length < 2) {
      console.info({
        event: "game_start",
        outcome: "not_enough_players",
        invalid_move_reason: "not_enough_players",
        ...gameStateContext,
      });
      throw new ConvexError({
        message: "Need at least 2 players to start",
        code: "GAME_NOT_ENOUGH_PLAYERS",
      });
    }

    const missingNamePlayerIds = players.filter((playerId) => {
      const name = playerNames[playerId];
      return typeof name !== "string" || name.trim().length === 0;
    });
    if (missingNamePlayerIds.length > 0) {
      console.info({
        event: "game_start",
        outcome: "missing_player_names",
        invalid_move_reason: "missing_player_names",
        ...gameStateContext,
      });
      throw new ConvexError({
        message: "All players must have names before starting",
        code: "GAME_MISSING_PLAYER_NAMES",
      });
    }

    if (room.gameId) {
      console.info({
        event: "game_start",
        outcome: "already_started",
        ...gameStateContext,
      });
      return { gameId: room.gameId as string, alreadyStarted: true };
    }

    // 2) Snapshot lobby
    const lobbySnapshot = {
      roomDocId: room._id,
      roomId: roomCode,
      hostId,
      players,
      playerNames,
    };

    // 3) Create a game state (deck + turn order + rules)
    // Deterministic seed (Convex-safe): depends only on the lobby snapshot.
    const seed = `room:${roomCode}|players:${players.join(",")}`;
    const deck = buildShuffledDeck(seed);
    const turnOrder = shuffleWithSeed(players, `turnOrder:${seed}`);

    const gameId = await ctx.db.insert("games", {
      roomId: roomCode,
      roomDocId: room._id,
      lobbySnapshot,
      phase: "playing",
      rules: DEFAULT_KINGS_CUP_RULES,
      deck,
      drawIndex: 0,
      discard: [],
      kingsDrawn: 0,
      turnOrder,
      turnIndex: 0,
      roundNumber: 1,
      drinksTakenTotal: 0,
    });

    await ctx.db.patch(room._id, {
      gameId,
      phase: "in_game",
    });

    // 4) Emit an event (for clients to subscribe to)
    const eventId = await ctx.db.insert("events", {
      type: "game_started",
      roomId: roomCode,
      gameId,
      payload: {
        lobbySnapshot,
        turnOrder,
        turnIndex: 0,
        rulesVersion: DEFAULT_KINGS_CUP_RULES.version,
      },
    });

    console.info({
      event: "game_start",
      outcome: "started",
      ...gameStateContext,
    });

    return { gameId, eventId, alreadyStarted: false };
  },
});

export const restartGame = mutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const room = await ctx.db
      .query("rooms")
      .filter((q) => q.eq(q.field("roomID"), args.roomId))
      .first();
    const gameStateContext = buildGameStateContext({
      session_id: args.roomId,
      player_id: args.userId,
    });

    if (!room) {
      console.info({
        event: "game_restart",
        outcome: "room_not_found",
        invalid_move_reason: "room_not_found",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Room not found", code: "ROOM_404" });
    }

    const roomCode = (room.roomID ?? args.roomId) as string;
    const players = normalizePlayers(room.players);
    const playerNames = normalizePlayerNames(room.playerNames);
    const hostId = players[0] ?? null;

    gameStateContext.session_id = roomCode;
    gameStateContext.total_players = players.length;
    gameStateContext.players_remaining = players.length;
    gameStateContext.is_host = hostId === args.userId;

    // 1) Validate
    if (!hostId || hostId !== args.userId) {
      console.info({
        event: "game_restart",
        outcome: "not_host",
        invalid_move_reason: "not_host",
        ...gameStateContext,
      });
      throw new ConvexError({
        message: "Only the host can restart the game",
        code: "GAME_NOT_HOST",
      });
    }

    if (!room.gameId) {
      console.info({
        event: "game_restart",
        outcome: "game_not_started",
        invalid_move_reason: "game_not_started",
        ...gameStateContext,
      });
      throw new ConvexError({
        message: "Game not started",
        code: "GAME_NOT_STARTED",
      });
    }

    if (players.length < 2) {
      console.info({
        event: "game_restart",
        outcome: "not_enough_players",
        invalid_move_reason: "not_enough_players",
        ...gameStateContext,
      });
      throw new ConvexError({
        message: "Need at least 2 players to restart",
        code: "GAME_NOT_ENOUGH_PLAYERS",
      });
    }

    const missingNamePlayerIds = players.filter((playerId) => {
      const name = playerNames[playerId];
      return typeof name !== "string" || name.trim().length === 0;
    });
    if (missingNamePlayerIds.length > 0) {
      console.info({
        event: "game_restart",
        outcome: "missing_player_names",
        invalid_move_reason: "missing_player_names",
        ...gameStateContext,
      });
      throw new ConvexError({
        message: "All players must have names before restarting",
        code: "GAME_MISSING_PLAYER_NAMES",
      });
    }

    const previousGameId = room.gameId as string;

    // 2) Snapshot lobby
    const lobbySnapshot = {
      roomDocId: room._id,
      roomId: roomCode,
      hostId,
      players,
      playerNames,
    };

    // 3) Create a game state (fresh deck + turn order + rules)
    // Seed includes previous game id so restarts produce a new shuffle deterministically.
    const seed = `room:${roomCode}|players:${players.join(",")}|prevGameId:${String(previousGameId)}`;
    const deck = buildShuffledDeck(seed);
    const turnOrder = shuffleWithSeed(players, `turnOrder:${seed}`);

    const gameId = await ctx.db.insert("games", {
      roomId: roomCode,
      roomDocId: room._id,
      lobbySnapshot,
      phase: "playing",
      rules: DEFAULT_KINGS_CUP_RULES,
      deck,
      drawIndex: 0,
      discard: [],
      kingsDrawn: 0,
      turnOrder,
      turnIndex: 0,
      roundNumber: 1,
      drinksTakenTotal: 0,
      previousGameId,
    });

    await ctx.db.patch(room._id, {
      gameId,
      phase: "in_game",
    });

    // 4) Emit an event
    const eventId = await ctx.db.insert("events", {
      type: "game_restarted",
      roomId: roomCode,
      gameId,
      payload: {
        previousGameId,
        lobbySnapshot,
        turnOrder,
        turnIndex: 0,
        rulesVersion: DEFAULT_KINGS_CUP_RULES.version,
      },
    });

    console.info({
      event: "game_restart",
      outcome: "restarted",
      ...gameStateContext,
    });

    return { gameId, previousGameId, eventId };
  },
});

export const getGameState = query({
  args: {
    roomId: v.string(),
    userId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const room = await ctx.db
      .query("rooms")
      .filter((q) => q.eq(q.field("roomID"), args.roomId))
      .first();
    const gameStateContext = buildGameStateContext({
      session_id: args.roomId,
      player_id: args.userId ?? null,
    });

    if (!room) {
      console.info({
        event: "get_game_state",
        outcome: "room_not_found",
        invalid_move_reason: "room_not_found",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Room not found", code: "ROOM_404" });
    }

    gameStateContext.session_id = (room.roomID ?? args.roomId) as string;

    if (!room.gameId) {
      console.info({
        event: "get_game_state",
        outcome: "game_not_started",
        invalid_move_reason: "game_not_started",
        ...gameStateContext,
      });
      return {
        game: null,
        currentPlayer: null,
        lastDrawnCard: null,
      };
    }

    const game = await ctx.db.get("games", room.gameId);
    if (!game) {
      console.info({
        event: "get_game_state",
        outcome: "game_not_found",
        invalid_move_reason: "game_not_found",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Game not found", code: "GAME_404" });
    }

    const lobbySnapshot = (game.lobbySnapshot ?? {}) as {
      players?: string[];
      playerNames?: Record<string, string>;
    };
    const turnOrder = normalizePlayers(game.turnOrder);
    const turnIndex =
      typeof game.turnIndex === "number" ? (game.turnIndex as number) : 0;
    const currentPlayerId = turnOrder[turnIndex] ?? null;
    const playerNames = normalizePlayerNames(lobbySnapshot.playerNames);
    const currentPlayer =
      currentPlayerId === null
        ? null
        : {
            userId: currentPlayerId,
            name: playerNames[currentPlayerId] ?? null,
          };

    const discard = Array.isArray(game.discard) ? game.discard : [];
    const lastDrawnCard =
      discard.length > 0 ? discard[discard.length - 1] : null;

    // Get the rule text for the last drawn card
    const rules = (game.rules ?? DEFAULT_KINGS_CUP_RULES) as {
      byRank?: Record<string, string>;
      version?: string;
    };
    const lastCardRule =
      lastDrawnCard && typeof lastDrawnCard === "object"
        ? (rules.byRank?.[(lastDrawnCard as { rank?: string }).rank ?? ""] ?? null)
        : null;

    gameStateContext.total_players = turnOrder.length;
    gameStateContext.players_remaining = turnOrder.length;
    gameStateContext.turn_index = turnIndex;
    if (lastDrawnCard && typeof lastDrawnCard === "object") {
      const card = lastDrawnCard as { rank?: string; suit?: string };
      gameStateContext.card_rank =
        typeof card.rank === "string" ? card.rank : null;
      gameStateContext.card_suit =
        typeof card.suit === "string" ? card.suit : null;
    }
    gameStateContext.round_number =
      typeof game.roundNumber === "number"
        ? (game.roundNumber as number)
        : null;
    gameStateContext.kings_drawn =
      typeof game.kingsDrawn === "number" ? (game.kingsDrawn as number) : null;

    console.info({
      event: "get_game_state",
      outcome: "game_state_returned",
      ...gameStateContext,
    });

    return {
      game,
      currentPlayer,
      lastDrawnCard,
      lastCardRule,
    };
  },
});
export const drawCard = mutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const room = await ctx.db
      .query("rooms")
      .filter((q) => q.eq(q.field("roomID"), args.roomId))
      .first();
    const gameStateContext = buildGameStateContext({
      session_id: args.roomId,
      player_id: args.userId,
    });

    if (!room) {
      console.info({
        event: "draw_card",
        outcome: "room_not_found",
        invalid_move_reason: "room_not_found",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Room not found", code: "ROOM_404" });
    }

    const roomCode = (room.roomID ?? args.roomId) as string;
    gameStateContext.session_id = roomCode;

    if (!room.gameId) {
      console.info({
        event: "draw_card",
        outcome: "game_not_started",
        invalid_move_reason: "game_not_started",
        ...gameStateContext,
      });
      throw new ConvexError({
        message: "Game not started",
        code: "GAME_NOT_STARTED",
      });
    }

    const game = await ctx.db.get("games", room.gameId);
    if (!game) {
      console.info({
        event: "draw_card",
        outcome: "game_not_found",
        invalid_move_reason: "game_not_found",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Game not found", code: "GAME_404" });
    }

    const turnOrder = normalizePlayers(game.turnOrder);
    const turnIndex =
      typeof game.turnIndex === "number" ? (game.turnIndex as number) : 0;
    const currentPlayerId = turnOrder[turnIndex] ?? null;

    gameStateContext.total_players = turnOrder.length;
    gameStateContext.players_remaining = turnOrder.length;
    gameStateContext.turn_index = turnIndex;
    gameStateContext.is_host = currentPlayerId === args.userId;

    if (!currentPlayerId) {
      console.info({
        event: "draw_card",
        outcome: "no_current_player",
        invalid_move_reason: "no_current_player",
        ...gameStateContext,
      });
      throw new ConvexError({
        message: "No current player",
        code: "GAME_NO_CURRENT_PLAYER",
      });
    }

    if (currentPlayerId !== args.userId) {
      console.info({
        event: "draw_card",
        outcome: "not_your_turn",
        invalid_move_reason: "not_your_turn",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Not your turn", code: "GAME_NOT_YOUR_TURN" });
    }

    const deck = Array.isArray(game.deck) ? game.deck : [];
    const drawIndex =
      typeof game.drawIndex === "number"
        ? (game.drawIndex as number)
        : Array.isArray(game.discard)
          ? game.discard.length
          : 0;

    if (drawIndex >= deck.length) {
      console.info({
        event: "draw_card",
        outcome: "deck_empty",
        invalid_move_reason: "deck_empty",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Deck is empty", code: "GAME_DECK_EMPTY" });
    }

    const card = deck[drawIndex] as {
      id?: string;
      rank?: string;
      suit?: string;
    };
    const discard = Array.isArray(game.discard) ? [...game.discard] : [];
    discard.push(card);

    const rules = (game.rules ?? DEFAULT_KINGS_CUP_RULES) as {
      byRank?: Record<string, string>;
      version?: string;
    };
    const ruleTriggered =
      typeof card.rank === "string"
        ? (rules.byRank?.[card.rank] ?? null)
        : null;
    const kingsDrawn =
      typeof game.kingsDrawn === "number" ? (game.kingsDrawn as number) : 0;
    const nextKingsDrawn = card.rank === "K" ? kingsDrawn + 1 : kingsDrawn;

    gameStateContext.card_rank =
      typeof card.rank === "string" ? card.rank : null;
    gameStateContext.card_suit =
      typeof card.suit === "string" ? card.suit : null;
    gameStateContext.rule_triggered = ruleTriggered;
    gameStateContext.kings_drawn = nextKingsDrawn;
    gameStateContext.round_number =
      typeof game.roundNumber === "number"
        ? (game.roundNumber as number)
        : null;

    await ctx.db.patch(game._id, {
      drawIndex: drawIndex + 1,
      discard,
      kingsDrawn: nextKingsDrawn,
    });

    const eventId = await ctx.db.insert("events", {
      type: "card_drawn",
      roomId: roomCode,
      gameId: room.gameId,
      payload: {
        playerId: args.userId,
        drawIndex,
        card,
        rule: ruleTriggered,
        rulesVersion: rules.version ?? null,
      },
    });

    console.info({
      event: "draw_card",
      outcome: "card_drawn",
      ...gameStateContext,
    });

    return { card, rule: ruleTriggered, drawIndex, eventId };
  },
});
export const endTurn = mutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const room = await ctx.db
      .query("rooms")
      .filter((q) => q.eq(q.field("roomID"), args.roomId))
      .first();
    const gameStateContext = buildGameStateContext({
      session_id: args.roomId,
      player_id: args.userId,
    });

    if (!room) {
      console.info({
        event: "end_turn",
        outcome: "room_not_found",
        invalid_move_reason: "room_not_found",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Room not found", code: "ROOM_404" });
    }

    const roomCode = (room.roomID ?? args.roomId) as string;
    gameStateContext.session_id = roomCode;

    if (!room.gameId) {
      console.info({
        event: "end_turn",
        outcome: "game_not_started",
        invalid_move_reason: "game_not_started",
        ...gameStateContext,
      });
      throw new ConvexError({
        message: "Game not started",
        code: "GAME_NOT_STARTED",
      });
    }

    const game = await ctx.db.get("games", room.gameId);
    if (!game) {
      console.info({
        event: "end_turn",
        outcome: "game_not_found",
        invalid_move_reason: "game_not_found",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Game not found", code: "GAME_404" });
    }

    const turnOrder = normalizePlayers(game.turnOrder);
    if (turnOrder.length === 0) {
      console.info({
        event: "end_turn",
        outcome: "no_turn_order",
        invalid_move_reason: "no_turn_order",
        ...gameStateContext,
      });
      throw new ConvexError({
        message: "No turn order",
        code: "GAME_NO_TURN_ORDER",
      });
    }

    const turnIndex =
      typeof game.turnIndex === "number" ? (game.turnIndex as number) : 0;
    const currentPlayerId = turnOrder[turnIndex] ?? null;

    gameStateContext.total_players = turnOrder.length;
    gameStateContext.players_remaining = turnOrder.length;
    gameStateContext.turn_index = turnIndex;

    if (!currentPlayerId) {
      console.info({
        event: "end_turn",
        outcome: "no_current_player",
        invalid_move_reason: "no_current_player",
        ...gameStateContext,
      });
      throw new ConvexError({
        message: "No current player",
        code: "GAME_NO_CURRENT_PLAYER",
      });
    }

    if (currentPlayerId !== args.userId) {
      console.info({
        event: "end_turn",
        outcome: "not_your_turn",
        invalid_move_reason: "not_your_turn",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Not your turn", code: "GAME_NOT_YOUR_TURN" });
    }

    const nextTurnIndex = (turnIndex + 1) % turnOrder.length;
    const wrapped = nextTurnIndex === 0;
    const roundNumber =
      typeof game.roundNumber === "number" ? (game.roundNumber as number) : 1;
    const nextRoundNumber = wrapped ? roundNumber + 1 : roundNumber;

    gameStateContext.round_number = nextRoundNumber;

    await ctx.db.patch(game._id, {
      turnIndex: nextTurnIndex,
      roundNumber: nextRoundNumber,
    });

    const eventId = await ctx.db.insert("events", {
      type: "turn_ended",
      roomId: roomCode,
      gameId: room.gameId,
      payload: {
        previousPlayerId: currentPlayerId,
        nextPlayerId: turnOrder[nextTurnIndex] ?? null,
        previousTurnIndex: turnIndex,
        nextTurnIndex,
        roundNumber: nextRoundNumber,
      },
    });

    console.info({
      event: "end_turn",
      outcome: "turn_ended",
      ...gameStateContext,
    });

    return { nextTurnIndex, nextPlayerId: turnOrder[nextTurnIndex], eventId };
  },
});
