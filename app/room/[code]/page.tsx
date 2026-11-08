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
import { hostIdOf, isHost, toGameState } from "@/lib/game/types";
import { PlayerActions } from "@/components/game/PlayerActions";
import { BackgroundPicker } from "@/components/BackgroundPicker";
import { pageClass, useBackground } from "@/lib/useBackground";

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

  const {
    state,
    playerId,
    error: socketError,
    sendStartGame,
    sendDrawCard,
    sendSetQuickFlip,
    sendSubmitRule,
    sendSubmitBan,
    sendResolveBattle,
    sendRestart,
    sendEndGame,
    sendSetChallengeType,
    sendKick,
    sendMakeHost,
    leaveRoom,
    removedReason,
  } = useRoomSocket(roomCode, playerName);
  const [bg, setBg] = useBackground();

  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const sortedPlayers = useMemo(
    () => [...state.players].sort((a, b) => a.seat - b.seat),
    [state.players],
  );

  const host = isHost(state, playerId);
  const currentHostId = hostIdOf(state);
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

  const handleLeaveRoom = async () => {
    await leaveRoom();
    window.location.href = "/";
  };

  const handleDrawCard = async () => {
    await sendDrawCard();
  };

  if (!roomCode) {
    return (
      <main data-bg={bg}
      className={pageClass(bg, "min-h-screen flex items-center justify-center p-4")}>
        <Card className="w-full max-w-md">
          <CardContent className="p-6 text-center text-muted-foreground">
            Invalid room code
          </CardContent>
        </Card>
      </main>
    );
  }

  if (removedReason === "kicked") {
    return (
      <main data-bg={bg} className={pageClass(bg, "min-h-screen flex items-center justify-center p-4")}>
        <Card className="w-full max-w-md">
          <CardContent className="space-y-4 p-6 text-center">
            <p className="font-medium">You were removed from the room by the host.</p>
            <Button onClick={() => (window.location.href = "/")} className="w-full">
              Back to home
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (!playerName.trim()) {
    return (
      <main data-bg={bg}
      className={pageClass(bg, "min-h-screen flex items-center justify-center p-4")}>
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
      <main data-bg={bg}
        className={pageClass(bg, "min-h-screen p-4")}>
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-sm tracking-widest text-muted-foreground">
            {roomCode}
          </span>
          <BackgroundPicker value={bg} onChange={setBg} />
        </div>
        <GameBoard
          roomCode={roomCode}
          userId={playerId}
          gameState={gameState}
          onDrawCard={handleDrawCard}
          onSubmitRule={sendSubmitRule}
          onSubmitBan={sendSubmitBan}
          onResolveBattle={sendResolveBattle}
          onRestart={sendRestart}
          onEndGame={sendEndGame}
          onMakeHost={sendMakeHost}
          onKick={sendKick}
          onLeave={handleLeaveRoom}
        />
        {displayError && (
          <div className="mx-auto mt-3 w-full max-w-xs rounded-md border border-destructive/50 bg-destructive/10 p-3 text-center text-sm text-destructive">
            {displayError}
          </div>
        )}
      </main>
    );
  }

  return (
    <main data-bg={bg}
      className={pageClass(bg, "min-h-screen flex items-center justify-center p-4")}>
      <Card className="w-full max-w-md backdrop-blur-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">Room Lobby</CardTitle>
          <CardDescription>
            <span className="font-mono text-xl tracking-widest text-primary">
              {roomCode}
            </span>
          </CardDescription>
          <BackgroundPicker value={bg} onChange={setBg} className="justify-center pt-2" />
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
                sortedPlayers.map((player) => (
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
                    <div className="flex items-center gap-2">
                      {player.id === currentHostId && (
                        <span className="text-xs bg-primary text-primary-foreground px-2 py-1 rounded">
                          Host
                        </span>
                      )}
                      {host && player.id !== playerId && (
                        <PlayerActions
                          playerName={player.name}
                          onMakeHost={() => sendMakeHost(player.id)}
                          onKick={() => sendKick(player.id)}
                        />
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="space-y-2 rounded-lg border bg-muted/50 p-3">
            <label className="flex items-center justify-between gap-3 text-sm font-medium">
              <span>Quick Flip Battle</span>
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={state.quickFlipEnabled}
                disabled={!host}
                onChange={(e) => void sendSetQuickFlip(e.target.checked)}
              />
            </label>
            {state.quickFlipEnabled && (
              <fieldset className="flex items-center gap-4 text-sm" disabled={!host}>
                <legend className="sr-only">Quick Flip challenge</legend>
                {(
                  [
                    ["flip_cup", "Cups"],
                    ["bottle_flip", "Bottles"],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="challenge-type"
                      value={value}
                      checked={state.challengeType === value}
                      onChange={() => void sendSetChallengeType(value)}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            )}
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {state.quickFlipEnabled
                ? `${
                    state.challengeType === "bottle_flip"
                      ? "Requires 2 water bottles."
                      : "Requires 2 plastic solo cups."
                  } Everyone plays the same challenge. Turn off to use Queen's Rule (create a rule) instead.`
                : "Queen's Rule: whoever draws the Queen creates a rule."}
            </p>
            {!host && (
              <p className="text-xs text-muted-foreground">Only the host can change this.</p>
            )}
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
