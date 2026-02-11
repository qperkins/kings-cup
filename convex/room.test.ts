import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import { modules } from "./test.setup";

const makeRoomCode = async (t: ReturnType<typeof convexTest>) => {
  // Create a valid Convex Id<string> without leaving a room doc behind.
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

describe("room functions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("createRoom inserts room and getRoomByCode returns it", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const t = convexTest(undefined, modules);
    const roomId = await makeRoomCode(t);

    await t.mutation(api.room.createRoom, {
      userId: "u1",
      roomId,
      playerName: "  Alice  ",
    });

    const room = await t.query(api.room.getRoomByCode, {
      roomId,
      userId: "u1",
    });

    expect(room.roomID).toBe(roomId);
    expect(room.players).toEqual(["u1"]);
    expect(room.playerNames.u1).toBe("Alice");
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "room_create", outcome: "created" }),
    );
  });

  it("joinRoom joins and re-join is idempotent", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const t = convexTest(undefined, modules);
    const roomId = await makeRoomCode(t);

    await t.mutation(api.room.createRoom, {
      userId: "host",
      roomId,
      playerName: "Host",
    });

    const join1 = await t.mutation(api.room.joinRoom, {
      userId: "u2",
      roomId: String(roomId),
      playerName: "Bob",
    });
    expect(join1).toEqual({ success: true, alreadyJoined: false });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "room_join", outcome: "joined" }),
    );

    const join2 = await t.mutation(api.room.joinRoom, {
      userId: "u2",
      roomId: String(roomId),
      playerName: "Bob",
    });
    expect(join2).toEqual({ success: true, alreadyJoined: true });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "room_join", outcome: "already_joined" }),
    );

    const room = await t.query(api.room.getRoomByCode, {
      roomId,
      userId: "host",
    });
    expect(room.players).toEqual(["host", "u2"]);
  });

  it("leaveRoom removes player; last player deletes room", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
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

    await t.mutation(api.room.leaveRoom, { userId: "u2", roomId });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "leave_room", outcome: "left_room" }),
    );
    const afterLeave = await t.query(api.room.getRoomByCode, {
      roomId,
      userId: "host",
    });
    expect(afterLeave.players).toEqual(["host"]);

    await t.mutation(api.room.leaveRoom, { userId: "host", roomId });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "leave_room", outcome: "room_deleted" }),
    );

    await expect(
      t.query(api.room.getRoomByCode, { roomId, userId: "host" }),
    ).rejects.toThrowError("Room not found");
  });
});

