import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import { modules } from "./test.setup";

const isEventType = (value: unknown, expectedType: string): boolean => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("type" in value)) {
    return false;
  }
  const typeValue = (value as Record<string, unknown>).type;
  return typeValue === expectedType;
};

const makeRoomCode = async (t: ReturnType<typeof convexTest>) => {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert("rooms", {
      roomID: "seed",
      players: [],
      playerNames: {},
    });
    await ctx.db.delete(id);
    return id;
  });
};

const setupStartedGame = async () => {
  const t = convexTest(undefined, modules);
  const roomId = await makeRoomCode(t);

  await t.mutation(api.room.createRoom, {
    userId: "host",
    roomId,
    playerName: "Host",
  });
  await t.mutation(api.room.joinRoom, {
    userId: "u2",
    roomId: String(roomId),
    playerName: "Bob",
  });

  const start = await t.mutation(api.game.startGame, {
    roomId,
    userId: "host",
  });

  return { t, roomId, start };
};

describe("game functions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("startGame creates game and is idempotent on double-click", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { t, roomId } = await setupStartedGame();

    const room = await t.query(api.room.getRoomByCode, {
      roomId,
      userId: "host",
    });
    expect(room.gameId).toBeTruthy();

    const second = await t.mutation(api.game.startGame, {
      roomId,
      userId: "host",
    });
    expect(second).toMatchObject({ alreadyStarted: true, gameId: room.gameId });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "game_start", outcome: "already_started" }),
    );
  });

  it("getGameState enriches currentPlayer and lastDrawnCard", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { t, roomId } = await setupStartedGame();

    const state = await t.query(api.game.getGameState, { roomId, userId: "host" });
    expect(state.game).toBeTruthy();
    if (!state.currentPlayer) {
      throw new Error("Expected currentPlayer to be set");
    }
    expect(state.currentPlayer.userId).toBe(
      state.game.turnOrder[state.game.turnIndex],
    );
    expect(state.lastDrawnCard).toBeNull();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "get_game_state",
        outcome: "game_state_returned",
      }),
    );
  });

  it("drawCard validates turn, updates discard/drawIndex, and creates event", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { t, roomId } = await setupStartedGame();

    const before = await t.query(api.game.getGameState, { roomId, userId: "host" });
    if (!before.currentPlayer) {
      throw new Error("Expected currentPlayer to be set");
    }
    const currentPlayerId = before.currentPlayer.userId;
    const otherPlayerId = currentPlayerId === "host" ? "u2" : "host";

    await expect(
      t.mutation(api.game.drawCard, { roomId, userId: otherPlayerId }),
    ).rejects.toThrowError("Not your turn");

    const draw = await t.mutation(api.game.drawCard, {
      roomId,
      userId: currentPlayerId,
    });
    expect(draw.card).toBeTruthy();
    expect(draw.drawIndex).toBe(0);

    const after = await t.query(api.game.getGameState, { roomId, userId: "host" });
    expect(after.game.drawIndex).toBe(1);
    expect(after.game.discard).toHaveLength(1);
    expect(after.lastDrawnCard).toBeTruthy();

    const events = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(Array.isArray(events)).toBe(true);
    expect((events as unknown[]).some((e) => isEventType(e, "card_drawn"))).toBe(
      true,
    );

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "draw_card", outcome: "card_drawn" }),
    );
  });

  it("endTurn advances turnIndex and creates a turn_ended event", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { t, roomId } = await setupStartedGame();

    const before = await t.query(api.game.getGameState, { roomId, userId: "host" });
    if (!before.currentPlayer) {
      throw new Error("Expected currentPlayer to be set");
    }
    const currentPlayerId = before.currentPlayer.userId;
    const otherPlayerId = currentPlayerId === "host" ? "u2" : "host";

    await expect(
      t.mutation(api.game.endTurn, { roomId, userId: otherPlayerId }),
    ).rejects.toThrowError("Not your turn");

    const end = await t.mutation(api.game.endTurn, { roomId, userId: currentPlayerId });
    expect(end.nextTurnIndex).toBe((before.game.turnIndex + 1) % before.game.turnOrder.length);

    const after = await t.query(api.game.getGameState, { roomId, userId: "host" });
    expect(after.game.turnIndex).toBe(end.nextTurnIndex);

    const events = await t.run(async (ctx) => ctx.db.query("events").collect());
    expect(Array.isArray(events)).toBe(true);
    expect((events as unknown[]).some((e) => isEventType(e, "turn_ended"))).toBe(
      true,
    );

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "end_turn", outcome: "turn_ended" }),
    );
  });
});

