"use client";

import { motion } from "motion/react";
import { WILD_DRINK } from "./wild-cards";

interface MateBrokenAlertProps {
  names: [string, string];
  onDismiss: () => void;
}

/** Shown to everyone when Treason breaks a mate pair: both ex-mates drink. */
export function MateBrokenAlert({ names, onDismiss }: MateBrokenAlertProps) {
  return (
    <motion.div
      role="alert"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onClick={onDismiss}
    >
      <motion.div
        className="max-w-xs rounded-3xl bg-purple-900 px-6 py-5 text-center text-white shadow-2xl"
        initial={{ scale: 0.7 }}
        animate={{ scale: 1 }}
        exit={{ scale: 0.9, opacity: 0, transition: { duration: 0.15 } }}
        transition={{ type: "spring", stiffness: 340, damping: 20 }}
      >
        <div className="text-4xl" aria-hidden>
          {"\u{1F494}"}
        </div>
        <p className="mt-1 text-xl font-extrabold">Treason!</p>
        <p className="mt-1 text-sm">
          {names[0]} and {names[1]} are no longer mates.
        </p>
        <p className="mt-2 text-lg font-bold text-yellow-300">
          Both take {WILD_DRINK}
        </p>
        <p className="mt-2 text-xs opacity-70">Tap to close</p>
      </motion.div>
    </motion.div>
  );
}
