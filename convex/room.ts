import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { buildGameStateContext } from "./logging";
import {
  normalizePlayerName,
  normalizePlayers,
  normalizePlayerNames,
} from "./utils";

export const createRoom = mutation({
  args: {
    userId: v.string(),
    roomId: v.string(),
    playerName: v.string(),
  },
  handler: async (ctx, args) => {
    const playerNames: Record<string, string> = {
      [args.userId]: normalizePlayerName(args.playerName),
    };
    await ctx.db.insert("rooms", {
      roomID: args.roomId,
      players: [args.userId],
      playerNames,
    });
    console.info({
      event: "room_create",
      outcome: "created",
      ...buildGameStateContext({
        session_id: args.roomId,
        total_players: 1,
        players_remaining: 1,
        player_id: args.userId,
        is_host: true,
      }),
    });
  },
});
export const joinRoom = mutation({
  args: {
    userId: v.string(),
    roomId: v.string(),
    playerName: v.string(),
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
        event: "room_join",
        outcome: "room_not_found",
        invalid_move_reason: "room_not_found",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Room not found", code: "ROOM_404" });
    }
    const players = normalizePlayers(room.players);
    const playerNames = normalizePlayerNames(room.playerNames);
    const normalizedPlayerName = normalizePlayerName(args.playerName);
    gameStateContext.session_id = room.roomID ?? args.roomId;
    gameStateContext.total_players = players.length;
    gameStateContext.players_remaining = players.length;
    if (players.includes(args.userId)) {
      if (playerNames[args.userId] !== normalizedPlayerName) {
        await ctx.db.patch(room._id, {
          playerNames: { ...playerNames, [args.userId]: normalizedPlayerName },
        });
      }
      console.info({
        event: "room_join",
        outcome: "already_joined",
        invalid_move_reason: "already_joined",
        ...gameStateContext,
      });
      return { success: true, alreadyJoined: true };
    }
    const updatedPlayers = [...players, args.userId];
    const updatedPlayerNames = {
      ...playerNames,
      [args.userId]: normalizedPlayerName,
    };
    await ctx.db.patch(room._id, {
      players: updatedPlayers,
      playerNames: updatedPlayerNames,
    });
    gameStateContext.total_players = players.length + 1;
    gameStateContext.players_remaining = players.length + 1;
    console.info({
      event: "room_join",
      outcome: "joined",
      ...gameStateContext,
    });
    return { success: true, alreadyJoined: false };
  },
});
export const getRoomByCode = query({
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
        event: "get_room_by_code",
        outcome: "room_not_found",
        invalid_move_reason: "room_not_found",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Room not found", code: "ROOM_404" });
    }
    const players = normalizePlayers(room.players);
    gameStateContext.total_players = players.length;
    gameStateContext.players_remaining = players.length;
    console.info({
      event: "get_room_by_code",
      outcome: "room_found",
      ...gameStateContext,
    });
    return room;
  },
});
export const listPlayers = query({
  args: {
    roomId: v.string(),
  },
  handler: async (ctx, args) => {
    const room = await ctx.db
      .query("rooms")
      .filter((q) => q.eq(q.field("roomID"), args.roomId))
      .first();
    const gameStateContext = buildGameStateContext({
      session_id: args.roomId,
    });
    if (!room) {
      console.info({
        event: "list_players",
        outcome: "room_not_found",
        invalid_move_reason: "room_not_found",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Room not found", code: "ROOM_404" });
    }
    const players = normalizePlayers(room.players);
    const playerNames = normalizePlayerNames(room.playerNames);
    const playersWithNames = players.map((playerId) => ({
      userId: playerId,
      name: playerNames[playerId] ?? null,
    }));
    gameStateContext.total_players = players.length;
    gameStateContext.players_remaining = players.length;
    console.info({
      event: "list_players",
      outcome: "players_listed",
      ...gameStateContext,
    });
    return playersWithNames;
  },
});

export const leaveRoom = mutation({
  args: {
    userId: v.string(),
    roomId: v.string(),
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
        event: "leave_room",
        outcome: "room_not_found",
        invalid_move_reason: "room_not_found",
        ...gameStateContext,
      });
      throw new ConvexError({ message: "Room not found", code: "ROOM_404" });
    }
    const players = normalizePlayers(room.players);
    const playerNames = normalizePlayerNames(room.playerNames);
    if (!players.includes(args.userId)) {
      console.info({
        event: "leave_room",
        outcome: "not_in_room",
        invalid_move_reason: "not_in_room",
        ...gameStateContext,
      });
      throw new ConvexError({
        message: "User not in room",
        code: "ROOM_NOT_IN_ROOM",
      });
    }
    const updatedPlayers = players.filter((player) => player !== args.userId);
    const updatedPlayerNames = { ...playerNames };
    delete updatedPlayerNames[args.userId];
    if (updatedPlayers.length === 0) {
      await ctx.db.delete(room._id);
      console.info({
        event: "leave_room",
        outcome: "room_deleted",
        ...gameStateContext,
      });
    } else {
      await ctx.db.patch(room._id, {
        players: updatedPlayers,
        playerNames: updatedPlayerNames,
      });
      gameStateContext.total_players = updatedPlayers.length;
      gameStateContext.players_remaining = updatedPlayers.length;
      console.info({
        event: "leave_room",
        outcome: "left_room",
        ...gameStateContext,
      });
    }
  },
});
