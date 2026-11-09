"use client";

import { motion } from "motion/react";
import { PlayingCard } from "./PlayingCard";
import { WildCard } from "./WildCard";
import type { CardData } from "./card-utils";

interface CardDrawnModalProps {
  drawerName: string;
  card: CardData;
  rule: string | null;
  /** Auto-dismiss time in ms (drives the countdown bar; the queue closes it). */
  duration: number;
  onDismiss: () => void;
}

/** Shown to every player when a card is drawn. Tap anywhere to dismiss. */
export function CardDrawnModal({
  drawerName,
  card,
  rule,
  duration,
  onDismiss,
}: CardDrawnModalProps) {
  return (
    <motion.div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onClick={onDismiss}
    >
      {card.wildId && (
        <div aria-hidden className="wild-vignette pointer-events-none fixed inset-0" />
      )}
      <motion.div
        className="flex w-full max-w-xs flex-col items-center gap-3 rounded-2xl bg-card p-5 text-center shadow-2xl"
        initial={{ scale: 0.7, y: 30 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, transition: { duration: 0.15 } }}
        transition={{ type: "spring", stiffness: 320, damping: 24 }}
      >
        <p className="text-lg font-bold">{drawerName} drew</p>
        <div className="w-36">
          {card.wildId ? (
            <WildCard wildId={card.wildId} reveal />
          ) : (
            <PlayingCard rank={card.rank} suit={card.suit} disableHover />
          )}
        </div>
        {rule && <p className="text-xl font-extrabold">{rule}</p>}
        <p className="text-xs text-muted-foreground">Tap to close</p>
        <motion.div
          className="h-1 self-start rounded-full bg-yellow-500"
          initial={{ width: "100%" }}
          animate={{ width: "0%" }}
          transition={{ duration: duration / 1000, ease: "linear" }}
        />
      </motion.div>
    </motion.div>
  );
}
