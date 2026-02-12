"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GameBoard } from "@/components/game/GameBoard";
import type { GameState } from "@/components/game/GameBoard";

function getStoredUserId(): string {
  if (typeof window === "undefined") return "";
  const stored = localStorage.getItem("kingscup_user_id");
  return stored ?? "";
}

export default function RoomPage() {
  const params = useParams();
  const roomCode = (params.code as string) ?? "";

  // userId is stable once set in localStorage by the homepage
  const [userId] = useState(() => getStoredUserId());
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  // ── Lobby query ──
  const players = useQuery(
    api.room.listPlayers,
    roomCode ? { roomId: roomCode } : "skip",
  );

  // ── Game state query (reactive — switches from lobby to game board) ──
  const gameStateRaw = useQuery(
    api.game.getGameState,
    roomCode && userId
      ? { roomId: roomCode, userId }
      : "skip",
  );

  const startGame = useMutation(api.game.startGame);
  const leaveRoom = useMutation(api.room.leaveRoom);

  // Derive isHost from players list without an effect
  const isHost = useMemo(() => {
    if (!players || players.length === 0 || !userId) return false;
    return players[0].userId === userId;
  }, [players, userId]);

  // Derive whether the game is active
  const gameActive = gameStateRaw?.game != null;

  const handleStartGame = async () => {
    if (!roomCode || !userId) return;

    setIsStarting(true);
    setError(null);

    try {
      await startGame({
        roomId: roomCode,
        userId,
      });
      // No navigation — the reactive getGameState query will switch the view
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to start game";
      setError(errorMessage);
      setIsStarting(false);
    }
  };

  const handleLeaveRoom = async () => {
    if (!roomCode || !userId) return;

    try {
      await leaveRoom({
        roomId: roomCode,
        userId,
      });
      window.location.href = "/";
    } catch {
      window.location.href = "/";
    }
  };

  // ── Invalid room code ──
  if (!roomCode) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-muted to-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-6 text-center text-muted-foreground">
            Invalid room code
          </CardContent>
        </Card>
      </main>
    );
  }

  // ── Game is active — render the game board ──
  if (gameActive && gameStateRaw) {
    const gameState: GameState = {
      game: gameStateRaw.game as GameState["game"],
      currentPlayer: gameStateRaw.currentPlayer as GameState["currentPlayer"],
      lastDrawnCard: gameStateRaw.lastDrawnCard as GameState["lastDrawnCard"],
    };

    return (
      <main className="min-h-screen bg-gradient-to-br from-background via-muted to-background p-4">
        <div className="text-center mb-2">
          <span className="font-mono text-sm tracking-widest text-muted-foreground/60">
            {roomCode}
          </span>
        </div>
        <GameBoard
          roomCode={roomCode}
          userId={userId}
          gameState={gameState}
        />
      </main>
    );
  }

  // ── Lobby view ──
  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-muted to-background p-4">
      <Card className="w-full max-w-md backdrop-blur-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">
            Room Lobby
          </CardTitle>
          <CardDescription>
            <span className="font-mono text-xl tracking-widest text-primary">
              {roomCode}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Player List */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium">
              Players ({players?.length ?? 0})
            </h3>
            <div className="space-y-2">
              {players === undefined ? (
                <div className="text-center text-muted-foreground py-4">
                  Loading players...
                </div>
              ) : players.length === 0 ? (
                <div className="text-center text-muted-foreground py-4">
                  No players yet
                </div>
              ) : (
                players.map((player, index) => (
                  <div
                    key={player.userId}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-medium">
                        {(player.name ?? "?").charAt(0).toUpperCase()}
                      </div>
                      <span className="font-medium">
                        {player.name ?? "Anonymous"}
                        {player.userId === userId && (
                          <span className="text-muted-foreground ml-2">(you)</span>
                        )}
                      </span>
                    </div>
                    {index === 0 && (
                      <span className="text-xs bg-primary text-primary-foreground px-2 py-1 rounded">
                        Host
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Waiting Message or Start Button */}
          {isHost ? (
            <div className="space-y-3">
              {players && players.length < 2 ? (
                <p className="text-center text-muted-foreground text-sm">
                  Waiting for at least one more player to join...
                </p>
              ) : null}
              <Button
                onClick={handleStartGame}
                disabled={
                  !players ||
                  players.length < 2 ||
                  isStarting ||
                  gameActive
                }
                className="w-full"
              >
                {isStarting ? "Starting..." : "Start Game"}
              </Button>
            </div>
          ) : (
            <p className="text-center text-muted-foreground text-sm">
              Waiting for the host to start the game...
            </p>
          )}

          {/* Error Message */}
          {error && (
            <div className="p-3 rounded-md bg-destructive/10 border border-destructive/50 text-destructive text-sm text-center">
              {error}
            </div>
          )}

          {/* Leave Room Button */}
          <Button
            onClick={handleLeaveRoom}
            variant="outline"
            className="w-full"
          >
            Leave Room
          </Button>

          {/* Share Info */}
          <div className="text-center text-muted-foreground text-sm">
            <p>Share this code with friends:</p>
            <p className="font-mono text-lg text-primary tracking-widest mt-1">
              {roomCode}
            </p>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
