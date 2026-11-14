"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { PlayingCard } from "./PlayingCard";
import { WildCard } from "./WildCard";
import { DECK_SIZE, KINGS_TO_END, WILD_CARDS, WILD_DRINK, type GameMode } from "./wild-cards";
import { PlayerRing } from "./PlayerRing";
import { RuleDisplay } from "./RuleDisplay";
import { GameOverOverlay } from "./GameOverOverlay";
import { RulesPanel } from "./RulesPanel";
import { CardDrawnModal } from "./CardDrawnModal";
import { TurnAlert } from "./TurnAlert";
import { MateBrokenAlert } from "./MateBrokenAlert";
import { useOverlayQueue, type OverlayItemBase } from "@/lib/useOverlayQueue";
import {
  installAudioUnlock,
  isMuted,
  notifyTurnExternally,
  playCardSound,
  playTurnChime,
  setMuted,
} from "@/lib/sound";
import type { Battle, PendingInput } from "@/lib/game/types";
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
  lastDrawnBy?: string | null;
  drawSeq?: number;
  quickFlipEnabled?: boolean;
  challengeType?: "flip_cup" | "bottle_flip";
  rules?: string[];
  bannedWords?: string[];
  pendingInput?: PendingInput | null;
  battle?: Battle | null;
  mates?: [string, string][];
  /** Last pair broken by Treason (live events only) and a counter that bumps per break. */
  lastBroken?: [string, string] | null;
  brokenSeq?: number;
  gameMode?: GameMode;
  direction?: 1 | -1;
}

interface GameBoardProps {
  roomCode: string;
  userId: string;
  gameState: GameState;
  onDrawCard: () => Promise<unknown>;
  onSubmitRule?: (text: string) => Promise<unknown>;
  onSubmitBan?: (word: string) => Promise<unknown>;
  onResolveBattle?: (loserId: string | null) => Promise<unknown>;
  onChooseMate?: (mateId: string) => Promise<unknown>;
  onChooseTarget?: (targetId: string) => Promise<unknown>;
  onBreakMate?: (a: string, b: string) => Promise<unknown>;
  onRestart?: () => Promise<unknown>;
  onReturnToLobby?: () => Promise<unknown>;
  onEndGame?: () => Promise<unknown>;
  onMakeHost?: (playerId: string) => Promise<unknown>;
  onKick?: (playerId: string) => Promise<unknown>;
  onLeave?: () => Promise<unknown>;
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
    description: `The player who drew the card picks a drinking mate on screen.
From now on, whenever either of them has to drink for any reason, both drink.
Mates are shown on both players' screens and listed in the Rules box. A player can end up with several mates (one for each 8 drawn), but links don't chain: only direct mates drink together.
The link lasts until the game ends or one of the pair leaves.`,
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
    name: "Jack's Trap",
    description: `The player who drew the card types a word.
That word is banned for the rest of the game.
Anyone who says it drinks. Banned words stay listed in the Rules box.`,
  },
  Q: {
    name: "Queen's Rule",
    description: `Create a rule!
The player who drew the card types a rule that everyone must follow for the rest of the game.
Break it and you drink. The rule stays listed in the Rules box.`,
  },
  K: {
    name: "King's Cup",
    description: `Place an empty cup in the middle of the table at the start of the game (the King's Cup).
Each time a King is drawn, the player pours some of their drink into the King's Cup.
When the fourth King is drawn, the player who drew that fourth King must drink the King's Cup (or take a large sip, if you want a lighter rule).`,
  },
} as const;

const QUICK_FLIP_HOWTO = {
  flip_cup:
    "Flip cup: set a cup on the table edge and flick the rim to land it upside down. (Needs 2 plastic solo cups.)",
  bottle_flip:
    "Water bottle flip: toss a bottle so it lands upright. (Needs 2 water bottles.)",
} as const;

function quickFlipRule(challenge: keyof typeof QUICK_FLIP_HOWTO) {
  return {
    name: "Quick Flip Battle",
    description: `The game picks a random player to battle the player who drew the card.
Both do the same challenge, one attempt each:
${QUICK_FLIP_HOWTO[challenge]}
The loser drinks.`,
  };
}

function battleTitle(battle: Battle | null): string {
  if (battle?.kind === "rps") return "Scepter Showdown";
  if (battle?.kind === "duel") return "Royal Duel";
  return "Quick Flip Battle";
}

const CHALLENGE_LABEL = { flip_cup: "Flip Cup", bottle_flip: "Water Bottle Flip" } as const;

type OverlayItem =
  | (OverlayItemBase & { kind: "card"; drawerName: string; card: CardData; rule: string | null })
  | (OverlayItemBase & { kind: "turn" })
  | (OverlayItemBase & { kind: "broken"; names: [string, string] });

const CARD_POPUP_MS = 3000;
// Turn popup stays until the player taps it.
const TURN_POPUP_MS = Infinity;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GameBoard({
  userId,
  gameState,
  onDrawCard,
  onSubmitRule,
  onSubmitBan,
  onResolveBattle,
  onChooseMate,
  onChooseTarget,
  onBreakMate,
  onRestart,
  onReturnToLobby,
  onEndGame,
  onMakeHost,
  onKick,
  onLeave,
}: GameBoardProps) {
  const { game, currentPlayer, lastDrawnCard, lastCardRule } = gameState;
  const quickFlipEnabled = gameState.quickFlipEnabled ?? true;
  const challengeType = gameState.challengeType ?? "flip_cup";
  const rules = gameState.rules ?? [];
  const bannedWords = gameState.bannedWords ?? [];
  const pendingInput = gameState.pendingInput ?? null;
  const battle = gameState.battle ?? null;
  const mates = gameState.mates ?? [];
  const gameMode = gameState.gameMode ?? "classic";
  const direction = gameState.direction ?? 1;
  const kingLimit = KINGS_TO_END[gameMode];

  const [inputText, setInputText] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const [isDrawing, setIsDrawing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idleNudge, setIdleNudge] = useState(false);
  const [soundOff, setSoundOff] = useState(false);
  const overlay = useOverlayQueue<OverlayItem>();

  // Derived values (computed without hooks, safe to use before/after return)
  const isMyTurn = currentPlayer?.userId === userId;
  const lobbySnapshot = game?.lobbySnapshot ?? {};
  const hostId = lobbySnapshot.hostId ?? (game?.turnOrder?.[0] ?? null);
  const isHost = hostId === userId;
  const kingsDrawn = game?.kingsDrawn ?? 0;
  // WS model doesn't ship full deck — derive count from drawIndex and the mode's deck size.
  const deckRemaining = Math.max(0, DECK_SIZE[gameMode] - (game?.drawIndex ?? 0));
  const cardsDrawn = game?.drawIndex ?? 0;
  const roundNumber = game?.roundNumber ?? 1;
  const isGameOver = game?.phase === "finished";
  const fourKings = kingsDrawn >= kingLimit; // the final King (4th classic, 6th Royal Mayhem)
  const blocked = pendingInput !== null || battle !== null;
  const nameOf = (id: string) => (lobbySnapshot.playerNames ?? {})[id] ?? "Someone";
  const myMateNames = mates
    .filter((pair) => pair.includes(userId))
    .map((pair) => nameOf(pair[0] === userId ? pair[1] : pair[0]));

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
    if (!isMyTurn || isDrawing) return;
    setIsDrawing(true);
    setError(null);

    try {
      await onDrawCard();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to draw card";
      setError(msg);
    } finally {
      setIsDrawing(false);
    }
  }, [isMyTurn, isDrawing, onDrawCard]);

  const canDraw = isMyTurn && !isGameOver && !blocked;

  // After 6s of an un-taken turn, escalate the "tap the deck" cue.
  useEffect(() => {
    if (!canDraw) {
      setIdleNudge(false);
      return;
    }
    const t = setTimeout(() => setIdleNudge(true), 6000);
    return () => clearTimeout(t);
  }, [canDraw, lastDrawnCard?.id]);

  // ── Popups + sound (hooks stay above the early return) ──
  useEffect(() => {
    setSoundOff(isMuted());
    return installAudioUnlock();
  }, []);

  const drawSeq = gameState.drawSeq ?? 0;
  const lastSeenDrawSeq = useRef(drawSeq);
  useEffect(() => {
    if (drawSeq === lastSeenDrawSeq.current) return;
    lastSeenDrawSeq.current = drawSeq;
    if (!lastDrawnCard) return;
    const drawerId = gameState.lastDrawnBy;
    overlay.push({
      key: `card-${drawSeq}`,
      kind: "card",
      duration: CARD_POPUP_MS,
      drawerName: drawerId === userId ? "You" : drawerId ? nameOf(drawerId) : "Someone",
      card: lastDrawnCard,
      rule: lastCardRule ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawSeq]);

  const brokenSeq = gameState.brokenSeq ?? 0;
  const lastSeenBrokenSeq = useRef(brokenSeq);
  useEffect(() => {
    if (brokenSeq === lastSeenBrokenSeq.current) return;
    lastSeenBrokenSeq.current = brokenSeq;
    const pair = gameState.lastBroken;
    if (!pair) return;
    overlay.push({
      key: `broken-${brokenSeq}`,
      kind: "broken",
      duration: 4000,
      names: [nameOf(pair[0]), nameOf(pair[1])],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokenSeq]);

  const wasMyTurn = useRef(false);
  const turnSeq = useRef(0);
  // Keyed on canDraw (not bare isMyTurn): a refresh while you still owe a mate/duel/treason pick or
  // battle report must not announce "Your turn, tap to draw" when you can't draw yet.
  useEffect(() => {
    if (canDraw && !wasMyTurn.current) {
      turnSeq.current += 1;
      overlay.push({ key: `turn-${turnSeq.current}`, kind: "turn", duration: TURN_POPUP_MS });
    }
    wasMyTurn.current = canDraw;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canDraw]);

  const currentOverlayKey = overlay.current?.key;
  const currentOverlayKind = overlay.current?.kind;
  useEffect(() => {
    if (currentOverlayKind === "turn") {
      playTurnChime();
      notifyTurnExternally(currentPlayer?.name ?? undefined);
    } else if (currentOverlayKind === "card") {
      playCardSound();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOverlayKey]);

  const runBusy = useCallback(async (fn?: () => Promise<unknown>) => {
    if (!fn) return;
    setIsBusy(true);
    try {
      await fn();
    } finally {
      setIsBusy(false);
    }
  }, []);

  const submitInput = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !pendingInput) return;
    setIsBusy(true);
    try {
      const result = (await (pendingInput.kind === "rule"
        ? onSubmitRule?.(text)
        : onSubmitBan?.(text))) as { success?: boolean } | undefined;
      if (result?.success !== false) setInputText("");
    } finally {
      setIsBusy(false);
    }
  }, [inputText, pendingInput, onSubmitRule, onSubmitBan]);

  // ── Early return (after all hooks) ──
  if (!game) return null;

  const drawnCardRank = lastDrawnCard?.rank ?? null;
  const drawnCardSuit = lastDrawnCard?.suit ?? null;
  const ruleForDisplay = lastCardRule ?? null;
  const detailedRule = (() => {
    if (lastDrawnCard?.wildId) return WILD_CARDS[lastDrawnCard.wildId] ?? null;
    if (!lastDrawnCard?.rank) return null;
    if (lastDrawnCard.rank === "Q" && quickFlipEnabled) return quickFlipRule(challengeType);
    if (lastDrawnCard.rank === "K" && gameMode === "royal_mayhem") {
      return {
        name: "King's Cup",
        description: `Place an empty cup in the middle of the table at the start of the game (the King's Cup).
Each time a King is drawn (including the 2 Kings of Chaos), the player pours some of their drink into the King's Cup.
In Royal Mayhem, when the ${kingLimit}th King is drawn the player who drew it must drink the King's Cup (or take one big drink, if you want a lighter rule).`,
      };
    }
    return kingsCupRules[lastDrawnCard.rank as keyof typeof kingsCupRules] ?? null;
  })();

  return (
    <LayoutGroup>
      <motion.div
        className="flex flex-col items-center gap-6 w-full max-w-lg mx-auto px-4 py-6 overflow-x-clip"
        animate={fourKings ? { scale: [1, 1.02, 1] } : undefined}
        transition={{ duration: 0.6 }}
      >
        <div className="flex w-full justify-end">
          <button
            type="button"
            aria-label={soundOff ? "Unmute sounds" : "Mute sounds"}
            className="rounded-full border bg-card px-3 py-1 text-sm"
            onClick={() => {
              setMuted(!soundOff);
              setSoundOff(!soundOff);
            }}
          >
            {soundOff ? "\u{1F507} Sound off" : "\u{1F50A} Sound on"}
          </button>
        </div>

        {/* ── Player Ring ── */}
        <PlayerRing
          players={players}
          currentPlayerId={currentPlayer?.userId ?? null}
          userId={userId}
          hostId={hostId}
          mates={mates}
          onMakeHost={isHost ? onMakeHost : undefined}
          onKick={isHost ? onKick : undefined}
        />

        {/* ── Turn indicator ── */}
        {canDraw ? (
          <motion.div
            className="cue-bg rounded-full px-5 py-2 text-base font-extrabold uppercase tracking-wide shadow-lg"
            animate={{ scale: [1, 1.06, 1] }}
            transition={{ duration: 1.2, repeat: Infinity }}
          >
            Your turn — draw a card!
          </motion.div>
        ) : (
          <p className="text-sm text-muted-foreground text-center">
            {blocked
              ? pendingInput
                ? `${nameOf(pendingInput.player_id)} is ${
                    pendingInput.kind === "rule"
                      ? "creating a rule"
                      : pendingInput.kind === "mate"
                        ? "choosing a drinking mate"
                        : pendingInput.kind === "duel"
                          ? "picking a duel opponent"
                          : pendingInput.kind === "treason"
                            ? "plotting treason"
                            : "choosing a banned word"
                  }...`
                : `${battleTitle(battle)} in progress...`
              : `Waiting for ${currentPlayer?.name ?? "someone"} to play...`}
          </p>
        )}

        {gameMode === "royal_mayhem" && (
          <div className="flex items-center gap-2 text-xs font-semibold text-purple-700 dark:text-purple-300">
            <span className="rounded-full bg-purple-600/15 px-3 py-1">
              {"\u{1F451}"} Royal Mayhem
            </span>
            {direction === -1 && (
              <span className="rounded-full bg-purple-600/15 px-3 py-1">
                {"\u{1F501}"} Reversed
              </span>
            )}
          </div>
        )}

        {myMateNames.length > 0 && (
          <div className="rounded-full bg-pink-600/15 px-3 py-1 text-xs font-semibold text-pink-700 dark:text-pink-300">
            &#10084;&#65039; Your mate{myMateNames.length > 1 ? "s" : ""}: {myMateNames.join(", ")}
            {" "}&mdash; when you drink, they drink
          </div>
        )}

        {/* ── Card Table ── */}
        <div className="relative flex items-center justify-center gap-4 min-[360px]:gap-8 min-h-[280px]">
          {/* Deck pile */}
          <div className="relative">
            {deckRemaining > 2 && (
              <div className="absolute top-[4px] left-[4px] w-[min(9.8rem,38vw)] opacity-60">
                <PlayingCard faceDown disableHover />
              </div>
            )}
            {deckRemaining > 1 && (
              <div className="absolute top-[2px] left-[2px] w-[min(9.8rem,38vw)] opacity-80">
                <PlayingCard faceDown disableHover />
              </div>
            )}
            <div className={cn("relative w-[min(9.8rem,38vw)] rounded-lg", canDraw && "draw-glow")}>
              <PlayingCard
                faceDown
                disableHover={!isMyTurn || blocked}
                onClick={isMyTurn && !isDrawing && !blocked ? handleDraw : undefined}
              />
            </div>
            <p className="text-center text-xs text-muted-foreground mt-1">
              {deckRemaining} left
            </p>
            {canDraw && (
              <p
                className={cn(
                  "cue-text mt-1 text-center text-xs font-bold",
                  idleNudge && "draw-nudge",
                )}
              >
                {idleNudge ? "\u261D Tap the deck!" : "Tap the deck or the button"}
              </p>
            )}
          </div>

          {/* Discard / drawn card area */}
          <div className="relative w-[min(9.8rem,38vw)] min-h-[160px] flex items-center justify-center">
            <AnimatePresence mode="wait">
              {lastDrawnCard ? (
                <motion.div
                  key={lastDrawnCard.id}
                  initial={
                    lastDrawnCard.wildId
                      ? { opacity: 0 }
                      : { x: -170, rotateY: 180, opacity: 0 }
                  }
                  animate={{ x: 0, rotateY: 0, opacity: 1 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={CARD_SPRING}
                  className={cn("w-[min(9.8rem,38vw)]", canDraw && "cursor-pointer")}
                  style={{ perspective: 800 }}
                  onClick={canDraw && !isDrawing ? handleDraw : undefined}
                >
                  {lastDrawnCard.wildId ? (
                    <WildCard wildId={lastDrawnCard.wildId} reveal />
                  ) : (
                    <PlayingCard
                      rank={lastDrawnCard.rank}
                      suit={lastDrawnCard.suit}
                      disableHover
                    />
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="empty-discard"
                  className="w-[min(9.8rem,38vw)] aspect-[169/245] rounded-lg border-2 border-dashed border-muted flex items-center justify-center"
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
          wildId={lastDrawnCard?.wildId ?? null}
        />

        {/* ── Kings Counter ── */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Kings:</span>
          {Array.from({ length: kingLimit }, (_, i) => i).map((i) => (
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

        {/* ── Quick Flip Battle ── */}
        {battle && (
          <div className="w-full max-w-xs space-y-3 rounded-lg border-2 border-primary bg-card p-4 text-center">
            <h3 className="text-lg font-bold">{battleTitle(battle)}!</h3>
            <p className="text-sm">
              <strong>{nameOf(battle.challenger_id)}</strong> vs{" "}
              <strong>{nameOf(battle.opponent_id)}</strong>
            </p>
            <p className="text-sm text-muted-foreground">
              {battle.kind === "rps"
                ? "Play rock-paper-scissors, best 2 out of 3. Loser takes 3 drinks!"
                : battle.kind === "duel"
                  ? `Challenge: ${CHALLENGE_LABEL[battle.challenge]} — one attempt each. Loser takes ${WILD_DRINK}!`
                  : `Challenge: ${CHALLENGE_LABEL[battle.challenge]} — one attempt each. Loser drinks!`}
            </p>
            {battle.challenger_id === userId ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Who lost?</p>
                <div className="flex gap-2">
                  {[battle.challenger_id, battle.opponent_id].map((id) => (
                    <Button
                      key={id}
                      variant="outline"
                      className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal break-words py-2"
                      disabled={isBusy}
                      onClick={() => runBusy(() => onResolveBattle?.(id) ?? Promise.resolve())}
                    >
                      {nameOf(id)}
                    </Button>
                  ))}
                </div>
                {battle.kind !== "rps" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    disabled={isBusy}
                    onClick={() => runBusy(() => onResolveBattle?.(null) ?? Promise.resolve())}
                  >
                    Tie — no drink
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Waiting for {nameOf(battle.challenger_id)} to report the result...
              </p>
            )}
          </div>
        )}

        {/* ── Mate picker (drawer only) ── */}
        {pendingInput?.kind === "mate" && pendingInput.player_id === userId && (
          <div className="w-full max-w-xs space-y-2 rounded-lg border-2 border-primary bg-card p-4">
            <h3 className="font-bold">Pick your drinking mate</h3>
            <p className="text-xs text-muted-foreground">
              When either of you drinks, you both drink.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {players
                .filter(
                  (p) =>
                    p.userId !== userId &&
                    !mates.some((pair) => pair.includes(p.userId) && pair.includes(userId)),
                )
                .map((p) => (
                  <Button
                    key={p.userId}
                    variant="outline"
                    disabled={isBusy}
                    onClick={() => runBusy(() => onChooseMate?.(p.userId) ?? Promise.resolve())}
                  >
                    &#10084;&#65039; {p.name ?? "Anon"}
                  </Button>
                ))}
            </div>
          </div>
        )}

        {/* ── Royal Duel: pick an opponent (drawer only) ── */}
        {pendingInput?.kind === "duel" && pendingInput.player_id === userId && (
          <div className="w-full max-w-xs space-y-2 rounded-lg border-2 border-primary bg-card p-4">
            <h3 className="font-bold">Royal Duel: pick your rival</h3>
            <div className="grid grid-cols-2 gap-2">
              {players
                .filter((p) => p.userId !== userId)
                .map((p) => (
                  <Button
                    key={p.userId}
                    variant="outline"
                    disabled={isBusy}
                    onClick={() => runBusy(() => onChooseTarget?.(p.userId) ?? Promise.resolve())}
                  >
                    {"\u2694\uFE0F"} {p.name ?? "Anon"}
                  </Button>
                ))}
            </div>
          </div>
        )}

        {/* ── Treason: break a mate pair (drawer only) ── */}
        {pendingInput?.kind === "treason" && pendingInput.player_id === userId && (
          <div className="w-full max-w-xs space-y-2 rounded-lg border-2 border-primary bg-card p-4">
            <h3 className="font-bold">Treason: break a mate link</h3>
            <p className="text-xs text-muted-foreground">
              Both ex-mates take {WILD_DRINK}.
            </p>
            <div className="space-y-2">
              {mates.map(([a, b]) => (
                <Button
                  key={`${a}-${b}`}
                  variant="outline"
                  className="w-full"
                  disabled={isBusy}
                  onClick={() => runBusy(() => onBreakMate?.(a, b) ?? Promise.resolve())}
                >
                  {nameOf(a)} {"\u{1F494}"} {nameOf(b)}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* ── Rule / banned-word entry (drawer only) ── */}
        {pendingInput &&
          (pendingInput.kind === "rule" || pendingInput.kind === "word_ban") &&
          pendingInput.player_id === userId && (
          <form
            className="w-full max-w-xs space-y-2 rounded-lg border-2 border-primary bg-card p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submitInput();
            }}
          >
            <h3 className="font-bold">
              {pendingInput.kind === "rule" ? "Create a rule" : "Ban a word"}
            </h3>
            <Input
              autoFocus
              value={inputText}
              maxLength={pendingInput.kind === "rule" ? 120 : 40}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={
                pendingInput.kind === "rule"
                  ? "e.g. No pointing with fingers"
                  : "e.g. drink"
              }
            />
            <Button variant="cue" type="submit" className="w-full" disabled={isBusy || !inputText.trim()}>
              {pendingInput.kind === "rule" ? "Add rule" : "Ban word"}
            </Button>
          </form>
        )}

        {/* ── Action Buttons ── */}
        {canDraw && (
          <Button
            variant="cue"
            onClick={handleDraw}
            disabled={isDrawing || deckRemaining <= 0}
            className={cn(
              "h-20 w-full max-w-sm rounded-2xl text-2xl font-extrabold shadow-xl",
              !isDrawing && "draw-shake",
            )}
          >
            {isDrawing ? "Drawing..." : "DRAW CARD"}
          </Button>
        )}

        {/* ── Rules created this game (Queen's Rules + Jack's Trap words) ── */}
        <RulesPanel
          rules={rules}
          bannedWords={bannedWords}
          mates={mates}
          nameOf={nameOf}
          youId={userId}
        />

        {/* ── Detailed Rules for Current Card ── */}
        {lastDrawnCard && detailedRule && (
          <motion.div
            key={`rules-${lastDrawnCard.wildId ?? lastDrawnCard.rank}-${quickFlipEnabled}-${challengeType}-${gameMode}`}
            className="w-full max-w-xs rounded-lg border bg-card p-4"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
          >
            <h3 className="font-bold text-lg mb-2">{detailedRule.name}</h3>
            <p className="text-sm text-muted-foreground whitespace-pre-line">
              {detailedRule.description}
            </p>
          </motion.div>
        )}

        {/* ── Round / Cards info ── */}
        <div className="flex gap-6 text-xs text-muted-foreground">
          <span>Round {roundNumber}</span>
          <span>{cardsDrawn} drawn</span>
        </div>

        {/* ── Host controls ── */}
        {isHost && !isGameOver && (
          <div className="flex w-full max-w-xs gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={isBusy}
              onClick={() => runBusy(onRestart)}
            >
              Restart
            </Button>
            {confirmEnd ? (
              <Button
                variant="destructive"
                size="sm"
                className="flex-1"
                disabled={isBusy}
                onClick={() => {
                  setConfirmEnd(false);
                  void runBusy(onEndGame);
                }}
              >
                Confirm end
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => setConfirmEnd(true)}
              >
                End game
              </Button>
            )}
          </div>
        )}

        {/* ── Leave room (everyone) ── */}
        {onLeave && (
          <div className="w-full max-w-xs">
            {confirmLeave ? (
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  className="flex-1"
                  disabled={isBusy}
                  onClick={() => void runBusy(onLeave)}
                >
                  Confirm leave
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1"
                  onClick={() => setConfirmLeave(false)}
                >
                  Stay
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground"
                onClick={() => setConfirmLeave(true)}
              >
                Leave room
              </Button>
            )}
          </div>
        )}

        {/* ── Error Message ── */}
        {error && (
          <div className="p-3 rounded-md bg-destructive/10 border border-destructive/50 text-destructive text-sm text-center w-full max-w-xs">
            {error}
          </div>
        )}
      </motion.div>

      {/* ── Card drawn / turn popups ── */}
      <AnimatePresence>
        {overlay.current?.kind === "card" && !isGameOver && (
          <CardDrawnModal
            key={overlay.current.key}
            drawerName={overlay.current.drawerName}
            card={overlay.current.card}
            rule={overlay.current.rule}
            duration={overlay.current.duration}
            onDismiss={overlay.dismiss}
          />
        )}
        {overlay.current?.kind === "broken" && !isGameOver && (
          <MateBrokenAlert
            key={overlay.current.key}
            names={overlay.current.names}
            onDismiss={overlay.dismiss}
          />
        )}
        {overlay.current?.kind === "turn" && !isGameOver && (
          <TurnAlert
            key={overlay.current.key}
            name={currentPlayer?.name ?? "friend"}
            onDismiss={overlay.dismiss}
          />
        )}
      </AnimatePresence>

      {/* ── Game Over Overlay ── */}
      <AnimatePresence>
        {isGameOver && (
          <GameOverOverlay
            playerName={currentPlayer?.name ?? "Someone"}
            kingCard={
              lastDrawnCard
                ? { rank: lastDrawnCard.rank, suit: lastDrawnCard.suit, wildId: lastDrawnCard.wildId }
                : null
            }
            roundNumber={roundNumber}
            cardsDrawn={cardsDrawn}
            isHost={isHost}
            showKingReveal={fourKings}
            kingLimit={kingLimit}
            onPlayAgain={onRestart ? () => void runBusy(onRestart) : undefined}
            onReturnToLobby={onReturnToLobby ? () => void runBusy(onReturnToLobby) : undefined}
            isRestarting={isBusy}
          />
        )}
      </AnimatePresence>
    </LayoutGroup>
  );
}
