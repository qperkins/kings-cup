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
}

interface GameBoardProps {
  roomCode: string;
  userId: string;
  gameState: GameState;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GameBoard({ roomCode, userId, gameState }: GameBoardProps) {
  const { game, currentPlayer, lastDrawnCard } = gameState;

  const drawCardMutation = useMutation(api.game.drawCard);
  const endTurnMutation = useMutation(api.game.endTurn);
  const restartGameMutation = useMutation(api.game.restartGame);

  // Local UI state
  const [drawnThisTurn, setDrawnThisTurn] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isEndingTurn, setIsEndingTurn] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [currentRule, setCurrentRule] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track turn index so we can detect turn changes and reset local state
  const prevTurnIndexRef = useRef<number | null>(null);
  const turnIndex = game?.turnIndex ?? 0;

  useEffect(() => {
    if (prevTurnIndexRef.current !== null && prevTurnIndexRef.current !== turnIndex) {
      setDrawnThisTurn(false);
      setCurrentRule(null);
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
      const result = await drawCardMutation({
        roomId: roomCode,
        userId,
      });

      setDrawnThisTurn(true);
      setCurrentRule(typeof result.rule === "string" ? result.rule : null);
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
      setCurrentRule(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to restart";
      setError(msg);
    } finally {
      setIsRestarting(false);
    }
  }, [restartGameMutation, roomCode, userId]);

  // ── Early return (after all hooks) ──
  if (!game) return null;

  // Determine drawn card display data
  const drawnCard: CardData | null =
    drawnThisTurn && lastDrawnCard ? lastDrawnCard : null;

  const drawnCardRank = drawnCard?.rank ?? null;
  const drawnCardSuit = drawnCard?.suit ?? null;
  const ruleForDisplay = drawnThisTurn ? currentRule : null;

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
        <p className="text-sm text-slate-300 text-center">
          {isMyTurn
            ? drawnThisTurn
              ? "Your turn \u2014 end turn when ready"
              : "Your turn \u2014 draw a card!"
            : `Waiting for ${currentPlayer?.name ?? "someone"} to play...`}
        </p>

        {/* ── Card Table ── */}
        <div className="relative flex items-center justify-center gap-8 min-h-[200px]">
          {/* Deck pile */}
          <div className="relative">
            {deckRemaining > 2 && (
              <div className="absolute top-[3px] left-[3px] w-28 opacity-60">
                <PlayingCard faceDown disableHover />
              </div>
            )}
            {deckRemaining > 1 && (
              <div className="absolute top-[1.5px] left-[1.5px] w-28 opacity-80">
                <PlayingCard faceDown disableHover />
              </div>
            )}
            <div className="relative w-28">
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
            <p className="text-center text-xs text-slate-400 mt-1">
              {deckRemaining} left
            </p>
          </div>

          {/* Discard / drawn card area */}
          <div className="relative w-28 min-h-[160px] flex items-center justify-center">
            <AnimatePresence mode="wait">
              {drawnCard ? (
                <motion.div
                  key={drawnCard.id}
                  initial={{ x: -120, rotateY: 180, opacity: 0 }}
                  animate={{ x: 0, rotateY: 0, opacity: 1 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={CARD_SPRING}
                  className="w-28"
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
                  className="w-28"
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
                  className="w-28 h-[160px] rounded-lg border-2 border-dashed border-slate-600 flex items-center justify-center"
                >
                  <span className="text-xs text-slate-500">Discard</span>
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
          <span className="text-xs text-slate-400">Kings:</span>
          {[0, 1, 2, 3].map((i) => (
            <motion.div
              key={i}
              className={cn(
                "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border",
                i < kingsDrawn
                  ? "bg-yellow-600 border-yellow-500 text-white"
                  : "bg-slate-700 border-slate-600 text-slate-500",
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
              className="flex-1 bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-50"
            >
              {isDrawing ? "Drawing..." : "Draw Card"}
            </Button>
            <Button
              onClick={handleEndTurn}
              disabled={!drawnThisTurn || isEndingTurn}
              variant="outline"
              className="flex-1 border-slate-600 text-slate-200 hover:bg-slate-700 hover:text-white disabled:opacity-50"
            >
              {isEndingTurn ? "Ending..." : "End Turn"}
            </Button>
          </div>
        )}

        {/* ── Round / Cards info ── */}
        <div className="flex gap-6 text-xs text-slate-500">
          <span>Round {roundNumber}</span>
          <span>{cardsDrawn} drawn</span>
        </div>

        {/* ── Error Message ── */}
        {error && (
          <div className="p-3 rounded-md bg-red-900/50 border border-red-700 text-red-200 text-sm text-center w-full max-w-xs">
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
