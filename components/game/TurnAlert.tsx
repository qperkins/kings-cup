"use client";

import { motion } from "motion/react";

interface TurnAlertProps {
  name: string;
  onDismiss: () => void;
}

/** "It's your turn" popup. Tap anywhere to dismiss; the queue auto-dismisses it. */
export function TurnAlert({ name, onDismiss }: TurnAlertProps) {
  return (
    <motion.div
      role="alert"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onClick={onDismiss}
    >
      <motion.div
        className="cue-bg rounded-3xl px-8 py-6 text-center shadow-2xl"
        initial={{ scale: 0.6, rotate: -4 }}
        animate={{ scale: 1, rotate: 0 }}
        exit={{ scale: 0.9, opacity: 0, transition: { duration: 0.15 } }}
        transition={{ type: "spring", stiffness: 380, damping: 18 }}
      >
        <div className="text-4xl" aria-hidden>
          {"\u{1F451}"}
        </div>
        <p className="mt-1 text-2xl font-extrabold">Your turn, {name}!</p>
        <p className="mt-1 text-sm font-medium opacity-80">Tap to draw a card</p>
      </motion.div>
    </motion.div>
  );
}
