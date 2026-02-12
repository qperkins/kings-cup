"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { PlayingCard } from "./PlayingCard";

interface GameOverOverlayProps {
  /** Name of the player who drew the 4th King */
  playerName: string;
  /** The 4th King card data */
  kingCard: { rank: string; suit: string } | null;
  /** Total rounds played */
  roundNumber: number;
  /** Total cards drawn */
  cardsDrawn: number;
  /** Whether the local user is the host */
  isHost: boolean;
  /** Called when the host clicks Play Again */
  onPlayAgain: () => void;
  /** True while the restartGame mutation is in flight */
  isRestarting: boolean;
}

export function GameOverOverlay({
  playerName,
  kingCard,
  roundNumber,
  cardsDrawn,
  isHost,
  onPlayAgain,
  isRestarting,
}: GameOverOverlayProps) {
  // Phase 1: King's Cup reveal, Phase 2: game over screen
  const [phase, setPhase] = useState<1 | 2>(1);

  useEffect(() => {
    const timer = setTimeout(() => setPhase(2), 3500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-md"
    >
      <AnimatePresence mode="wait">
        {/* ─── Phase 1: King's Cup Reveal ─── */}
        {phase === 1 && (
          <motion.div
            key="reveal"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="flex flex-col items-center gap-6 px-6"
          >
            {kingCard && (
              <motion.div
                initial={{ rotateY: 180, scale: 0.5 }}
                animate={{ rotateY: 0, scale: 1 }}
                transition={{ type: "spring", stiffness: 200, damping: 20, delay: 0.3 }}
                className="w-36"
                style={{ perspective: 800 }}
              >
                <PlayingCard
                  rank={kingCard.rank}
                  suit={kingCard.suit}
                  disableHover
                />
              </motion.div>
            )}

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.8 }}
              className="text-2xl font-bold text-foreground text-center"
            >
              {playerName} drew the 4th King!
            </motion.p>

            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1.4 }}
              className="text-lg text-muted-foreground text-center"
            >
              They drink the King&apos;s Cup!
            </motion.p>
          </motion.div>
        )}

        {/* ─── Phase 2: Game Over ─── */}
        {phase === 2 && (
          <motion.div
            key="gameover"
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="flex flex-col items-center gap-6 rounded-2xl bg-card/90 border backdrop-blur-md px-10 py-8 max-w-sm w-full mx-4"
          >
            <h2 className="text-3xl font-bold">Game Over</h2>

            <div className="flex gap-8 text-center">
              <div>
                <p className="text-2xl font-semibold text-primary">
                  {roundNumber}
                </p>
                <p className="text-xs text-muted-foreground">Rounds</p>
              </div>
              <div>
                <p className="text-2xl font-semibold text-primary">
                  {cardsDrawn}
                </p>
                <p className="text-xs text-muted-foreground">Cards Drawn</p>
              </div>
            </div>

            {isHost ? (
              <Button
                onClick={onPlayAgain}
                disabled={isRestarting}
                className="w-full"
              >
                {isRestarting ? "Restarting..." : "Play Again"}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground text-center">
                Waiting for the host to restart...
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
