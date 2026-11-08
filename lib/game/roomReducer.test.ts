import { describe, expect, it } from "vitest";
import { initialRoomState, reduceRoomEvent } from "./roomReducer";
import { hostIdOf, isHost } from "./types";

const base = initialRoomState("ROOM");

describe("new game events", () => {
  it("settings_updated toggles quick flip", () => {
    const s = reduceRoomEvent(base, "settings_updated", { quick_flip_enabled: false });
    expect(base.quickFlipEnabled).toBe(true);
    expect(s.quickFlipEnabled).toBe(false);
  });

  it("input_required then rule_added / word_banned", () => {
    let s = reduceRoomEvent(base, "input_required", {
      pending_input: { player_id: "p1", kind: "rule" },
      battle: null,
    });
    expect(s.pendingInput?.kind).toBe("rule");
    s = reduceRoomEvent(s, "rule_added", { text: "no pointing" });
    expect(s.pendingInput).toBeNull();
    expect(s.rules).toEqual(["no pointing"]);
    s = reduceRoomEvent(s, "word_banned", { word: "drink" });
    expect(s.bannedWords).toEqual(["drink"]);
  });

  it("battle_resolved clears the battle", () => {
    let s = reduceRoomEvent(base, "input_required", {
      pending_input: null,
      battle: { challenger_id: "a", opponent_id: "b", challenge: "flip_cup" },
    });
    expect(s.battle?.opponent_id).toBe("b");
    s = reduceRoomEvent(s, "battle_resolved", { loser_id: "a" });
    expect(s.battle).toBeNull();
  });

  it("game_restarted resets pile, rules and bans", () => {
    const dirty = {
      ...base,
      rules: ["x"],
      bannedWords: ["y"],
      kingsDrawn: 3,
      phase: "finished" as const,
    };
    const s = reduceRoomEvent(dirty, "game_restarted", {
      room_id: "ROOM",
      phase: "in_progress",
      players: [],
      current_turn_seat: 0,
      kings_drawn: 0,
      cards_remaining: 52,
      drawn_pile_top: null,
      rules: [],
      banned_words: [],
      pending_input: null,
      battle: null,
      quick_flip_enabled: true,
    });
    expect(s.rules).toEqual([]);
    expect(s.bannedWords).toEqual([]);
    expect(s.kingsDrawn).toBe(0);
    expect(s.lastDrawnCard).toBeNull();
    expect(s.phase).toBe("in_progress");
  });

  it("state_sync hydrates rules and bans for reconnects", () => {
    const s = reduceRoomEvent(base, "state_sync", {
      room_id: "ROOM",
      phase: "in_progress",
      players: [],
      rules: ["a"],
      banned_words: ["b"],
    });
    expect(s.rules).toEqual(["a"]);
    expect(s.bannedWords).toEqual(["b"]);
  });
});

const view = (overrides: Record<string, unknown> = {}) => ({
  room_id: "ROOM",
  phase: "in_progress",
  players: [
    { id: "a", name: "A", seat: 0, connected: true },
    { id: "b", name: "B", seat: 1, connected: true },
    { id: "c", name: "C", seat: 2, connected: true },
  ],
  current_turn_seat: 0,
  kings_drawn: 0,
  cards_remaining: 40,
  drawn_pile_top: null,
  host_id: "a",
  challenge_type: "flip_cup",
  ...overrides,
});

describe("membership and host events", () => {
  it("state_sync carries host_id and challenge_type", () => {
    const s = reduceRoomEvent(base, "state_sync", view({ host_id: "b", challenge_type: "bottle_flip" }));
    expect(s.hostId).toBe("b");
    expect(s.challengeType).toBe("bottle_flip");
  });

  it("settings_updated sets the challenge type", () => {
    const s = reduceRoomEvent(base, "settings_updated", {
      quick_flip_enabled: true,
      challenge_type: "bottle_flip",
    });
    expect(base.challengeType).toBe("flip_cup");
    expect(s.challengeType).toBe("bottle_flip");
  });

  it("host_changed moves the host; isHost follows host_id, not seat", () => {
    let s = reduceRoomEvent(base, "state_sync", view());
    expect(isHost(s, "a")).toBe(true);
    s = reduceRoomEvent(s, "host_changed", { host_id: "c" });
    expect(isHost(s, "c")).toBe(true);
    expect(isHost(s, "a")).toBe(false);
    expect(hostIdOf(s)).toBe("c");
  });

  it("hostIdOf falls back to the lowest seat when host_id is unknown", () => {
    const s = reduceRoomEvent(base, "state_sync", view({ host_id: "ghost" }));
    expect(hostIdOf(s)).toBe("a");
  });

  it("player_removed re-applies the repaired view (roster, host, turn, battle)", () => {
    let s = reduceRoomEvent(base, "state_sync", view({
      current_turn_seat: 1,
      battle: { challenger_id: "b", opponent_id: "c", challenge: "flip_cup" },
    }));
    expect(s.battle).not.toBeNull();
    s = reduceRoomEvent(s, "player_removed", view({
      player_id: "b",
      reason: "left",
      players: [
        { id: "a", name: "A", seat: 0, connected: true },
        { id: "c", name: "C", seat: 2, connected: true },
      ],
      current_turn_seat: 2,
      battle: null,
    }));
    expect(s.players.map((p) => p.id)).toEqual(["a", "c"]);
    expect(s.currentTurnSeat).toBe(2);
    expect(s.battle).toBeNull();
  });

  it("a mid-game join shows up in the roster", () => {
    let s = reduceRoomEvent(base, "state_sync", view());
    s = reduceRoomEvent(s, "player_joined", { id: "d", name: "D", seat: 3, connected: true });
    expect(s.players.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });
});
