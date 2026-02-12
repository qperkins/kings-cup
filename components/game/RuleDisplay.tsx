"use client";

import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { rankLabel, suitSymbol, suitColorClass } from "./card-utils";

interface RuleDisplayProps {
  rank: string | null;
  suit: string | null;
  rule: string | null;
}

export function RuleDisplay({ rank, suit, rule }: RuleDisplayProps) {
  const visible = rank !== null && rule !== null;

  return (
    <AnimatePresence mode="wait">
      {visible && (
        <motion.div
          key={`${rank}-${suit}-${rule}`}
          initial={{ opacity: 0, scale: 0.9, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className="flex flex-col items-center gap-1 rounded-xl bg-card/80 backdrop-blur-md border px-6 py-4"
        >
          <span className="text-sm text-muted-foreground">
            {rankLabel(rank!)}{" "}
            <span className={cn(suitColorClass(suit ?? ""))}>
              {suitSymbol(suit ?? "")}
            </span>
          </span>
          <span className="text-xl font-bold">{rule}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
