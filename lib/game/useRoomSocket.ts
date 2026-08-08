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
  isRetryableServerError,
  sendIntentWithRetry,
  type PendingVerdict,
  type ServerVerdict,
} from "./sendWithRetry";
import type { RoomState } from "./types";

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
  "error",
] as const;

export function useRoomSocket(roomId: string, playerName: string) {
  const [state, setState] = useState<RoomState>(() => initialRoomState(roomId));
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          setPlayerId(yourId);
        }
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
  }, [roomId, playerName, handleEvent, waitForVerdict]);

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

  const disconnect = useCallback(() => {
    joinedRef.current = false;
    joinInFlightRef.current = false;
    cancelPendingVerdict(getPendingVerdict);
    socketRef.current = null;
  }, [getPendingVerdict]);

  return {
    state,
    playerId,
    error,
    sendStartGame,
    sendDrawCard,
    disconnect,
  };
}
