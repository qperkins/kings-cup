"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GameSocket } from "@kings-cup/shared";
import {
  initialRoomState,
  reduceRoomEvent,
  type ServerEventPayload,
} from "./roomReducer";
import {
  cancelPendingVerdict,
  createVerdictWaiter,
  deliverErrorToPendingVerdict,
  deliverSuccessToPendingVerdict,
  isRetryableServerError,
  sendIntentWithRetry,
  type PendingVerdict,
} from "./sendWithRetry";
import type { ChallengeType, RoomState } from "./types";

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000";

const EVENT_TYPES = [
  "state_sync",
  "player_joined",
  "player_reconnected",
  "game_started",
  "card_drawn",
  "turn_advanced",
  "game_finished",
  "settings_updated",
  "host_changed",
  "players_reordered",
  "player_removed",
  "input_required",
  "rule_added",
  "word_banned",
  "battle_resolved",
  "mate_chosen",
  "mate_broken",
  "direction_changed",
  "player_exiled",
  "game_restarted",
  "returned_to_lobby",
  "action_success",
  "error",
] as const;

export function useRoomSocket(roomId: string, playerName: string) {
  const [state, setState] = useState<RoomState>(() => initialRoomState(roomId));
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the server removed *us* (kicked). The page shows a notice and goes home.
  const [removedReason, setRemovedReason] = useState<"kicked" | null>(null);
  const playerIdRef = useRef<string | null>(null);

  const socketRef = useRef<GameSocket | null>(null);
  const joinedRef = useRef(false);
  const joinInFlightRef = useRef(false);
  // Single-slot verdict waiter per tab (not keyed by action_id — server error
  // events carry no action_id). One in-flight send at a time is safe per tab.
  //
  // Known limitation: if a fatal error arrives AFTER the 12s verdict timeout
  // already resolved { kind: "ok" }, deliverErrorToPendingVerdict returns false
  // (no pending waiter) and handleEvent may call setError(detail) — misattributing
  // a stale rejection to the user's current action. Retryable "Room busy" errors
  // are swallowed; only fatal EngineError messages can flash incorrectly.
  // TODO: backend should echo action_id on error events so the client can ignore
  // stragglers from prior attempts — out of scope for this pass.
  const pendingVerdictRef = useRef<PendingVerdict | null>(null);

  const getPendingVerdict = useCallback(
    () => pendingVerdictRef.current,
    [],
  );
  const setPendingVerdict = useCallback(
    (pending: PendingVerdict | null) => {
      pendingVerdictRef.current = pending;
    },
    [],
  );

  const waitForVerdict = useCallback(
    () => createVerdictWaiter(getPendingVerdict, setPendingVerdict)(),
    [getPendingVerdict, setPendingVerdict],
  );

  const handleEvent = useCallback(
    (eventType: string, payload: ServerEventPayload) => {
      if (eventType === "state_sync") {
        const yourId = payload.your_player_id;
        if (typeof yourId === "string") {
          GameSocket.saveResumeToken(yourId);
          playerIdRef.current = yourId;
          setPlayerId(yourId);
        }
      }

      if (
        eventType === "player_removed" &&
        payload.player_id === playerIdRef.current &&
        playerIdRef.current !== null
      ) {
        // We're the one who was removed. Forget the session and stop reconnecting.
        GameSocket.clearResumeToken();
        socketRef.current?.close();
        if (payload.reason === "kicked") setRemovedReason("kicked");
        return;
      }

      if (eventType === "action_success") {
        deliverSuccessToPendingVerdict(getPendingVerdict);
        return;
      }

      if (eventType === "error") {
        const detail = payload.detail;
        if (typeof detail === "string") {
          if (deliverErrorToPendingVerdict(getPendingVerdict, detail)) {
            return;
          }
          if (isRetryableServerError(detail)) {
            return;
          }
          setError(detail);
        }
        return;
      }

      setState((prev) => reduceRoomEvent(prev, eventType, payload));
    },
    [getPendingVerdict],
  );

  useEffect(() => {
    if (!roomId || !playerName.trim()) return;

    const socket = new GameSocket(roomId, WS_URL);
    socketRef.current = socket;

    for (const type of EVENT_TYPES) {
      socket.on(type, (payload) => handleEvent(type, payload));
    }

    let cancelled = false;

    const connectAndJoin = async () => {
      if (joinInFlightRef.current || joinedRef.current) return;
      joinInFlightRef.current = true;

      const connectResult = await socket.connect();
      if (cancelled) return;

      if (!connectResult.success) {
        joinInFlightRef.current = false;
        setError("Failed to connect to game server");
        setState((prev) => ({ ...prev, joining: false, connected: false }));
        return;
      }

      setState((prev) => ({ ...prev, connected: true }));

      const joinResult = await sendIntentWithRetry(
        socket,
        {
          type: "join",
          player_name: playerName.trim(),
          resume_token: GameSocket.getResumeToken() ?? undefined,
        },
        waitForVerdict,
      );

      joinInFlightRef.current = false;
      if (cancelled) return;

      if (!joinResult.success) {
        const message =
          typeof joinResult.error === "string"
            ? joinResult.error
            : "Failed to join room";
        setError(message);
        setState((prev) => ({ ...prev, joining: false }));
        return;
      }

      joinedRef.current = true;
    };

    void connectAndJoin();

    return () => {
      cancelled = true;
      joinedRef.current = false;
      joinInFlightRef.current = false;
      cancelPendingVerdict(getPendingVerdict);
      socketRef.current = null;
    };
  }, [roomId, playerName, handleEvent, waitForVerdict, getPendingVerdict]);

  const sendStartGame = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return { success: false as const, error: "Not connected" };

    setError(null);
    const result = await sendIntentWithRetry(
      socket,
      { type: "start_game" },
      waitForVerdict,
    );
    if (!result.success) {
      const message =
        typeof result.error === "string" ? result.error : "Failed to start game";
      setError(message);
    }
    return result;
  }, [waitForVerdict]);

  const sendDrawCard = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket || !playerId) {
      return { success: false as const, error: "Not connected" };
    }

    setError(null);
    const result = await sendIntentWithRetry(
      socket,
      { type: "draw_card", player_id: playerId },
      waitForVerdict,
    );
    if (!result.success) {
      const message =
        typeof result.error === "string" ? result.error : "Failed to draw card";
      setError(message);
    }
    return result;
  }, [playerId, waitForVerdict]);

  // Generic sender for the simple intents below (host controls, rule/ban
  // submission, battle result). All carry player_id; the server enforces who
  // is allowed to do what.
  const sendSimple = useCallback(
    async (
      intent: { type: string; [key: string]: unknown },
      failMessage: string,
    ) => {
      const socket = socketRef.current;
      if (!socket || !playerId) {
        return { success: false as const, error: "Not connected" };
      }
      setError(null);
      const result = await sendIntentWithRetry(
        socket,
        { ...intent, player_id: playerId },
        waitForVerdict,
      );
      if (!result.success) {
        setError(typeof result.error === "string" ? result.error : failMessage);
      }
      return result;
    },
    [playerId, waitForVerdict],
  );

  const sendSetQuickFlip = useCallback(
    (enabled: boolean) =>
      sendSimple({ type: "set_quick_flip", enabled }, "Failed to update setting"),
    [sendSimple],
  );
  const sendSubmitRule = useCallback(
    (text: string) => sendSimple({ type: "submit_rule", text }, "Failed to add rule"),
    [sendSimple],
  );
  const sendSubmitBan = useCallback(
    (word: string) => sendSimple({ type: "submit_ban", word }, "Failed to ban word"),
    [sendSimple],
  );
  const sendChooseMate = useCallback(
    (mateId: string) =>
      sendSimple({ type: "choose_mate", mate_id: mateId }, "Failed to choose mate"),
    [sendSimple],
  );
  const sendChooseTarget = useCallback(
    (targetId: string) =>
      sendSimple({ type: "choose_target", target_id: targetId }, "Failed to pick opponent"),
    [sendSimple],
  );
  const sendBreakMate = useCallback(
    (a: string, b: string) => sendSimple({ type: "break_mate", a, b }, "Failed to break mates"),
    [sendSimple],
  );
  const sendSetGameMode = useCallback(
    (mode: "classic" | "royal_mayhem") =>
      sendSimple({ type: "set_game_mode", mode }, "Failed to update game mode"),
    [sendSimple],
  );
  const sendResolveBattle = useCallback(
    (loserId: string | null) =>
      sendSimple({ type: "resolve_battle", loser_id: loserId }, "Failed to report result"),
    [sendSimple],
  );
  const sendRestart = useCallback(
    () => sendSimple({ type: "restart_game" }, "Failed to restart game"),
    [sendSimple],
  );
  const sendReturnToLobby = useCallback(
    () => sendSimple({ type: "return_to_lobby" }, "Failed to return to lobby"),
    [sendSimple],
  );
  const sendEndGame = useCallback(
    () => sendSimple({ type: "end_game" }, "Failed to end game"),
    [sendSimple],
  );

  const sendSetChallengeType = useCallback(
    (challengeType: ChallengeType) =>
      sendSimple(
        { type: "set_challenge_type", challenge_type: challengeType },
        "Failed to update setting",
      ),
    [sendSimple],
  );
  const sendReorderPlayers = useCallback(
    (order: string[]) =>
      sendSimple({ type: "reorder_players", order }, "Failed to reorder players"),
    [sendSimple],
  );
  const sendShufflePlayers = useCallback(
    () => sendSimple({ type: "shuffle_players" }, "Failed to randomize order"),
    [sendSimple],
  );
  const sendKick = useCallback(
    (targetId: string) =>
      sendSimple({ type: "kick_player", target_id: targetId }, "Failed to remove player"),
    [sendSimple],
  );
  const sendMakeHost = useCallback(
    (targetId: string) =>
      sendSimple({ type: "make_host", target_id: targetId }, "Failed to make host"),
    [sendSimple],
  );

  /** Close this tab's connection for good and forget the session. */
  const disconnect = useCallback(() => {
    joinedRef.current = false;
    joinInFlightRef.current = false;
    cancelPendingVerdict(getPendingVerdict);
    GameSocket.clearResumeToken();
    socketRef.current?.close();
    socketRef.current = null;
  }, [getPendingVerdict]);

  /** Tell the server we're leaving (so the roster, turn and host are repaired
   * for everyone else), then close. Closes even if the server can't be reached. */
  const leaveRoom = useCallback(async () => {
    if (socketRef.current && playerIdRef.current) {
      await sendSimple({ type: "leave_room" }, "Failed to leave room");
    }
    disconnect();
  }, [sendSimple, disconnect]);

  return {
    state,
    playerId,
    error,
    sendStartGame,
    sendDrawCard,
    sendSetQuickFlip,
    sendSubmitRule,
    sendSubmitBan,
    sendResolveBattle,
    sendChooseMate,
    sendChooseTarget,
    sendBreakMate,
    sendSetGameMode,
    sendRestart,
    sendReturnToLobby,
    sendEndGame,
    sendSetChallengeType,
    sendKick,
    sendMakeHost,
    sendReorderPlayers,
    sendShufflePlayers,
    leaveRoom,
    removedReason,
    disconnect,
  };
}
