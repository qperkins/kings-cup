"use client";

import { Suspense, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GameBoard } from "@/components/game/GameBoard";
import { useRoomSocket } from "@/lib/game/useRoomSocket";
import { isHost, toGameState } from "@/lib/game/types";

export default function RoomPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen flex items-center justify-center">
          <p className="text-muted-foreground">Loading room...</p>
        </main>
      }
    >
      <RoomPageContent />
    </Suspense>
  );
}

function RoomPageContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const roomCode = (params.code as string) ?? "";
  const playerName = searchParams.get("name") ?? "";

  const { state, playerId, error: socketError, sendStartGame, sendDrawCard, disconnect } =
    useRoomSocket(roomCode, playerName);

  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const sortedPlayers = useMemo(
    () => [...state.players].sort((a, b) => a.seat - b.seat),
    [state.players],
  );

  const host = isHost(state, playerId);
  const gameActive = state.phase === "in_progress" || state.phase === "finished";
  const displayError = error ?? socketError;

  const handleStartGame = async () => {
    if (!roomCode || !playerId) return;

    setIsStarting(true);
    setError(null);

    const result = await sendStartGame();
    if (!result.success) {
      setError("Failed to start game");
    }
    setIsStarting(false);
  };

  const handleLeaveRoom = () => {
    disconnect();
    window.location.href = "/";
  };

  const handleDrawCard = async () => {
    await sendDrawCard();
  };

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

  if (!playerName.trim()) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-muted to-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-6 text-center text-muted-foreground">
            Missing player name. Go back and enter your name first.
          </CardContent>
        </Card>
      </main>
    );
  }

  if (gameActive && playerId) {
    const gameState = toGameState(state);

    return (
      <main className="min-h-screen bg-gradient-to-br from-background via-muted to-background p-4">
        <div className="text-center mb-2">
          <span className="font-mono text-sm tracking-widest text-muted-foreground/60">
            {roomCode}
          </span>
        </div>
        <GameBoard
          roomCode={roomCode}
          userId={playerId}
          gameState={gameState}
          onDrawCard={handleDrawCard}
        />
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-muted to-background p-4">
      <Card className="w-full max-w-md backdrop-blur-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">Room Lobby</CardTitle>
          <CardDescription>
            <span className="font-mono text-xl tracking-widest text-primary">
              {roomCode}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <h3 className="text-sm font-medium">
              Players ({sortedPlayers.length})
            </h3>
            <div className="space-y-2">
              {state.joining && sortedPlayers.length === 0 ? (
                <div className="text-center text-muted-foreground py-4">
                  Connecting...
                </div>
              ) : sortedPlayers.length === 0 ? (
                <div className="text-center text-muted-foreground py-4">
                  No players yet
                </div>
              ) : (
                sortedPlayers.map((player, index) => (
                  <div
                    key={player.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-medium">
                        {player.name.charAt(0).toUpperCase()}
                      </div>
                      <span className="font-medium">
                        {player.name}
                        {player.id === playerId && (
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

          {host ? (
            <div className="space-y-3">
              {sortedPlayers.length < 2 ? (
                <p className="text-center text-muted-foreground text-sm">
                  Waiting for at least one more player to join...
                </p>
              ) : null}
              <Button
                onClick={handleStartGame}
                disabled={
                  !playerId ||
                  sortedPlayers.length < 2 ||
                  isStarting ||
                  gameActive
                }
                className="w-full"
              >
                {isStarting ? "Starting..." : "Start Game"}
              </Button>
            </div>
          ) : playerId ? (
            <p className="text-center text-muted-foreground text-sm">
              Waiting for the host to start the game...
            </p>
          ) : (
            <p className="text-center text-muted-foreground text-sm">
              Joining room...
            </p>
          )}

          {displayError && (
            <div className="p-3 rounded-md bg-destructive/10 border border-destructive/50 text-destructive text-sm text-center">
              {displayError}
            </div>
          )}

          <Button
            onClick={handleLeaveRoom}
            variant="outline"
            className="w-full"
          >
            Leave Room
          </Button>

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
