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
import { LobbyPlayerList } from "@/components/game/LobbyPlayerList";
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
          onChooseMate={sendChooseMate}
          onChooseTarget={sendChooseTarget}
          onBreakMate={sendBreakMate}
          onRestart={sendRestart}
          onReturnToLobby={sendReturnToLobby}
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
                <LobbyPlayerList
                  players={sortedPlayers}
                  playerId={playerId}
                  hostId={currentHostId}
                  canReorder={host}
                  onReorder={sendReorderPlayers}
                  onShuffle={sendShufflePlayers}
                  onMakeHost={sendMakeHost}
                  onKick={sendKick}
                />
              )}
            </div>
          </div>

          <fieldset
            className="space-y-2 rounded-lg border bg-muted/50 p-3"
            disabled={!host}
          >
            <legend className="px-1 text-sm font-medium">Game mode</legend>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["classic", "Classic", "Standard 52-card Kings Cup."],
                  [
                    "royal_mayhem",
                    "\u{1F451} Royal Mayhem",
                    "12 Court of Chaos wildcards, 6 Kings to end it.",
                  ],
                ] as const
              ).map(([value, label, blurb]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={state.gameMode === value}
                  onClick={() => void sendSetGameMode(value)}
                  className={
                    "rounded-lg border-2 p-2 text-left text-sm transition-colors " +
                    (state.gameMode === value
                      ? value === "royal_mayhem"
                        ? "border-purple-600 bg-purple-600/15"
                        : "border-primary bg-primary/10"
                      : "border-transparent bg-background/60 hover:bg-background")
                  }
                >
                  <span className="block font-semibold">{label}</span>
                  <span className="block text-xs text-muted-foreground">{blurb}</span>
                </button>
              ))}
            </div>
            {!host && (
              <p className="text-xs text-muted-foreground">Only the host can change this.</p>
            )}
          </fieldset>

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
                variant="cue"
                onClick={handleStartGame}
                disabled={
                  !playerId ||
                  sortedPlayers.length < 2 ||
                  isStarting ||
                  gameActive
                }
                className="h-11 w-full text-base"
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
