"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useMutation } from "convex/react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { PlayingCard } from "./PlayingCard";
import { PlayerRing } from "./PlayerRing";
import { RuleDisplay } from "./RuleDisplay";
import { GameOverOverlay } from "./GameOverOverlay";
import type { CardData } from "./card-utils";
import { CARD_SPRING } from "./card-utils";

// ---------------------------------------------------------------------------
// Types derived from getGameState return shape
// ---------------------------------------------------------------------------

interface LobbySnapshot {
  players?: string[];
  playerNames?: Record<string, string>;
  hostId?: string;
}

interface GameDoc {
  phase: string;
  deck: CardData[];
  drawIndex: number;
  discard: CardData[];
  kingsDrawn: number;
  turnOrder: string[];
  turnIndex: number;
  roundNumber: number;
  rules: { version: string; byRank: Record<string, string> };
  lobbySnapshot: LobbySnapshot;
  drinksTakenTotal: number;
  roomId: string;
}

interface CurrentPlayer {
  userId: string;
  name: string | null;
}

export interface GameState {
  game: GameDoc | null;
  currentPlayer: CurrentPlayer | null;
  lastDrawnCard: CardData | null;
  lastCardRule?: string | null;
}

interface GameBoardProps {
  roomCode: string;
  userId: string;
  gameState: GameState;
}

// ---------------------------------------------------------------------------
// Detailed Rules Data
// ---------------------------------------------------------------------------

const kingsCupRules = {
  A: {
    name: "Waterfall",
    description: `Everyone starts drinking at the same time.
The player who drew the card starts first, then going clockwise each player starts once the previous player has started.
No one can stop drinking until the person before them stops; the first player chooses when to stop, which lets everyone else stop in order.`,
  },
  "2": {
    name: "You",
    description: `The player who drew the card chooses one person to drink.
They point to or name a player and that person takes a drink.`,
  },
  "3": {
    name: "Me",
    description: `The player who drew the card drinks themselves.
No one else is affected.`,
  },
  "4": {
    name: "Floor",
    description: `Everyone races to touch the floor.
The last person to touch the floor drinks.
If someone can't reach the floor, agree on an alternative (like touching a chair leg) before playing.`,
  },
  "5": {
    name: "Guys",
    description: `All men at the table drink.
You can re-theme this (for inclusivity) to something like "left side of the table drinks" if your group prefers.`,
  },
  "6": {
    name: "Chicks",
    description: `All women at the table drink.
You can re-theme this (for inclusivity) to something like "right side of the table drinks" if your group prefers.`,
  },
  "7": {
    name: "Heaven",
    description: `Everyone races to point one hand up toward the ceiling.
The last person to raise their hand drinks.
If someone can't raise a hand, agree on a substitute action (like saying "Heaven") beforehand.`,
  },
  "8": {
    name: "Mate",
    description: `The player who drew the card chooses a mate (partner).
From now on, whenever either of them has to drink for any reason, both drink.
This link lasts until the game ends or the group agrees to cancel it.`,
  },
  "9": {
    name: "Rhyme",
    description: `The player who drew the card says one word out loud.
Going clockwise, each player must say a new word that rhymes with that word.
No repeats and use a short time limit (e.g., 3 seconds); the first person who fails, repeats, or is too slow drinks.`,
  },
  "10": {
    name: "Categories",
    description: `The player who drew the card announces a category (e.g., types of beer, car brands, NBA teams).
Going clockwise, each player must name something that fits the category.
No repeats and use a short time limit; the first person who fails, repeats, or names something that doesn't fit drinks.`,
  },
  J: {
    name: "Never Have I Ever",
    description: `Everyone starts with 3 fingers up (or another number you choose).
The player who drew the card says "Never have I ever..." followed by something they've never done.
Anyone who has done that thing puts one finger down and drinks.
You can do a quick mini-round (each player says one statement) or just one statement from the drawer.`,
  },
  Q: {
    name: "Questions",
    description: `Players enter a "questions only" mini-game.
Starting with the player who drew the card and going clockwise, each player must speak only in questions directed at other players.
If someone makes a statement, repeats a question, or takes too long to respond, that person drinks and the mini-game ends (unless you choose to continue).`,
  },
  K: {
    name: "King's Cup",
    description: `Place an empty cup in the middle of the table at the start of the game (the King's Cup).
Each time a King is drawn, the player pours some of their drink into the King's Cup.
When the fourth King is drawn, the player who drew that fourth King must drink the King's Cup (or take a large sip, if you want a lighter rule).`,
  },
} as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GameBoard({ roomCode, userId, gameState }: GameBoardProps) {
  const { game, currentPlayer, lastDrawnCard, lastCardRule } = gameState;

  const drawCardMutation = useMutation(api.game.drawCard);
  const endTurnMutation = useMutation(api.game.endTurn);
  const restartGameMutation = useMutation(api.game.restartGame);

  // Local UI state
  const [drawnThisTurn, setDrawnThisTurn] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isEndingTurn, setIsEndingTurn] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track turn index so we can detect turn changes and reset local state
  const prevTurnIndexRef = useRef<number | null>(null);
  const turnIndex = game?.turnIndex ?? 0;

  useEffect(() => {
    if (prevTurnIndexRef.current !== null && prevTurnIndexRef.current !== turnIndex) {
      setDrawnThisTurn(false);
    }
    prevTurnIndexRef.current = turnIndex;
  }, [turnIndex]);

  // Derived values (computed without hooks, safe to use before/after return)
  const isMyTurn = currentPlayer?.userId === userId;
  const lobbySnapshot = game?.lobbySnapshot ?? {};
  const hostId = lobbySnapshot.hostId ?? (game?.turnOrder?.[0] ?? null);
  const isHost = hostId === userId;
  const kingsDrawn = game?.kingsDrawn ?? 0;
  const deckRemaining = (game?.deck?.length ?? 52) - (game?.drawIndex ?? 0);
  const cardsDrawn = game?.drawIndex ?? 0;
  const roundNumber = game?.roundNumber ?? 1;
  const isGameOver = kingsDrawn >= 4;

  const players = useMemo(() => {
    const turnOrder = game?.turnOrder ?? [];
    const playerNames = (lobbySnapshot.playerNames ?? {}) as Record<string, string>;
    return turnOrder.map((pid: string) => ({
      userId: pid,
      name: playerNames[pid] ?? null,
    }));
  }, [game?.turnOrder, lobbySnapshot.playerNames]);

  // ── Handlers (all hooks must be above the early return) ──

  const handleDraw = useCallback(async () => {
    if (!isMyTurn || drawnThisTurn || isDrawing) return;
    setIsDrawing(true);
    setError(null);

    try {
      await drawCardMutation({
        roomId: roomCode,
        userId,
      });

      setDrawnThisTurn(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to draw card";
      setError(msg);
    } finally {
      setIsDrawing(false);
    }
  }, [isMyTurn, drawnThisTurn, isDrawing, drawCardMutation, roomCode, userId]);

  const handleEndTurn = useCallback(async () => {
    if (!isMyTurn || !drawnThisTurn || isEndingTurn) return;
    setIsEndingTurn(true);
    setError(null);

    try {
      await endTurnMutation({
        roomId: roomCode,
        userId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to end turn";
      setError(msg);
    } finally {
      setIsEndingTurn(false);
    }
  }, [isMyTurn, drawnThisTurn, isEndingTurn, endTurnMutation, roomCode, userId]);

  const handlePlayAgain = useCallback(async () => {
    setIsRestarting(true);
    setError(null);

    try {
      await restartGameMutation({
        roomId: roomCode,
        userId,
      });
      setDrawnThisTurn(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to restart";
      setError(msg);
    } finally {
      setIsRestarting(false);
    }
  }, [restartGameMutation, roomCode, userId]);

  // ── Early return (after all hooks) ──
  if (!game) return null;

  // Determine drawn card display data - show for ALL players
  const drawnCard: CardData | null =
    drawnThisTurn && lastDrawnCard ? lastDrawnCard : null;

  const drawnCardRank = lastDrawnCard?.rank ?? null;
  const drawnCardSuit = lastDrawnCard?.suit ?? null;
  const ruleForDisplay = lastCardRule ?? null;

  return (
    <LayoutGroup>
      <motion.div
        className="flex flex-col items-center gap-6 w-full max-w-lg mx-auto px-4 py-6"
        animate={isGameOver ? { scale: [1, 1.02, 1] } : undefined}
        transition={{ duration: 0.6 }}
      >
        {/* ── Player Ring ── */}
        <PlayerRing
          players={players}
          currentPlayerId={currentPlayer?.userId ?? null}
          userId={userId}
          hostId={hostId}
        />

        {/* ── Turn indicator text ── */}
        <p className="text-sm text-muted-foreground text-center">
          {isMyTurn
            ? drawnThisTurn
              ? "Your turn \u2014 end turn when ready"
              : "Your turn \u2014 draw a card!"
            : `Waiting for ${currentPlayer?.name ?? "someone"} to play...`}
        </p>

        {/* ── Card Table ── */}
        <div className="relative flex items-center justify-center gap-8 min-h-[280px]">
          {/* Deck pile */}
          <div className="relative">
            {deckRemaining > 2 && (
              <div className="absolute top-[4px] left-[4px] w-[9.8rem] opacity-60">
                <PlayingCard faceDown disableHover />
              </div>
            )}
            {deckRemaining > 1 && (
              <div className="absolute top-[2px] left-[2px] w-[9.8rem] opacity-80">
                <PlayingCard faceDown disableHover />
              </div>
            )}
            <div className="relative w-[9.8rem]">
              <PlayingCard
                faceDown
                disableHover={!isMyTurn || drawnThisTurn}
                onClick={
                  isMyTurn && !drawnThisTurn && !isDrawing
                    ? handleDraw
                    : undefined
                }
              />
            </div>
            <p className="text-center text-xs text-muted-foreground mt-1">
              {deckRemaining} left
            </p>
          </div>

          {/* Discard / drawn card area */}
          <div className="relative w-[9.8rem] min-h-[224px] flex items-center justify-center">
            <AnimatePresence mode="wait">
              {drawnCard ? (
                <motion.div
                  key={drawnCard.id}
                  initial={{ x: -170, rotateY: 180, opacity: 0 }}
                  animate={{ x: 0, rotateY: 0, opacity: 1 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={CARD_SPRING}
                  className="w-[9.8rem]"
                  style={{ perspective: 800 }}
                >
                  <PlayingCard
                    rank={drawnCard.rank}
                    suit={drawnCard.suit}
                    disableHover
                  />
                </motion.div>
              ) : lastDrawnCard ? (
                <motion.div
                  key={`last-${lastDrawnCard.id}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.5 }}
                  className="w-[9.8rem]"
                >
                  <PlayingCard
                    rank={lastDrawnCard.rank}
                    suit={lastDrawnCard.suit}
                    disableHover
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="empty-discard"
                  className="w-[9.8rem] h-[224px] rounded-lg border-2 border-dashed border-muted flex items-center justify-center"
                >
                  <span className="text-xs text-muted-foreground">Discard</span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* ── Rule Display ── */}
        <RuleDisplay
          rank={drawnCardRank}
          suit={drawnCardSuit}
          rule={ruleForDisplay}
        />

        {/* ── Kings Counter ── */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Kings:</span>
          {[0, 1, 2, 3].map((i) => (
            <motion.div
              key={i}
              className={cn(
                "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border",
                i < kingsDrawn
                  ? "bg-yellow-600 border-yellow-500 text-white"
                  : "bg-muted border text-muted-foreground",
              )}
              animate={i < kingsDrawn ? { scale: [1, 1.2, 1] } : undefined}
              transition={{ duration: 0.3 }}
            >
              K
            </motion.div>
          ))}
        </div>

        {/* ── Action Buttons ── */}
        {isMyTurn && !isGameOver && (
          <div className="flex gap-3 w-full max-w-xs">
            <Button
              onClick={handleDraw}
              disabled={drawnThisTurn || isDrawing || deckRemaining <= 0}
              className="flex-1"
            >
              {isDrawing ? "Drawing..." : "Draw Card"}
            </Button>
            <Button
              onClick={handleEndTurn}
              disabled={!drawnThisTurn || isEndingTurn}
              variant="outline"
              className="flex-1"
            >
              {isEndingTurn ? "Ending..." : "End Turn"}
            </Button>
          </div>
        )}

        {/* ── Detailed Rules for Current Card ── */}
        {lastDrawnCard?.rank && kingsCupRules[lastDrawnCard.rank as keyof typeof kingsCupRules] && (
          <motion.div
            key={`rules-${lastDrawnCard.rank}`}
            className="w-full max-w-xs rounded-lg border bg-card p-4"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
          >
            <h3 className="font-bold text-lg mb-2">
              {kingsCupRules[lastDrawnCard.rank as keyof typeof kingsCupRules].name}
            </h3>
            <p className="text-sm text-muted-foreground whitespace-pre-line">
              {kingsCupRules[lastDrawnCard.rank as keyof typeof kingsCupRules].description}
            </p>
          </motion.div>
        )}

        {/* ── Round / Cards info ── */}
        <div className="flex gap-6 text-xs text-muted-foreground">
          <span>Round {roundNumber}</span>
          <span>{cardsDrawn} drawn</span>
        </div>

        {/* ── Error Message ── */}
        {error && (
          <div className="p-3 rounded-md bg-destructive/10 border border-destructive/50 text-destructive text-sm text-center w-full max-w-xs">
            {error}
          </div>
        )}
      </motion.div>

      {/* ── Game Over Overlay ── */}
      <AnimatePresence>
        {isGameOver && (
          <GameOverOverlay
            playerName={currentPlayer?.name ?? "Someone"}
            kingCard={
              lastDrawnCard
                ? { rank: lastDrawnCard.rank, suit: lastDrawnCard.suit }
                : null
            }
            roundNumber={roundNumber}
            cardsDrawn={cardsDrawn}
            isHost={isHost}
            onPlayAgain={handlePlayAgain}
            isRestarting={isRestarting}
          />
        )}
      </AnimatePresence>
    </LayoutGroup>
  );
}
