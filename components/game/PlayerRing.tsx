"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";

interface Player {
  userId: string;
  name: string | null;
}

interface PlayerRingProps {
  players: Player[];
  currentPlayerId: string | null;
  userId: string;
  hostId: string | null;
}

export function PlayerRing({
  players,
  currentPlayerId,
  userId,
  hostId,
}: PlayerRingProps) {
  return (
    <div className="flex flex-wrap justify-center gap-3">
      {players.map((player) => {
        const isCurrent = player.userId === currentPlayerId;
        const isYou = player.userId === userId;
        const isHost = player.userId === hostId;
        const initial = (player.name ?? "?").charAt(0).toUpperCase();

        return (
          <div
            key={player.userId}
            className="relative flex flex-col items-center gap-1"
          >
            {/* Animated turn indicator ring */}
            {isCurrent && (
              <motion.div
                layoutId="turn-indicator"
                className="absolute -inset-1 rounded-full border-2 border-primary shadow-[0_0_12px_hsl(var(--primary)/0.5)]"
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
              />
            )}

            <div
              className={cn(
                "relative w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-colors",
                isCurrent
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {initial}
            </div>

            <span
              className={cn(
                "text-xs max-w-[72px] truncate text-center",
                isCurrent ? "text-foreground font-medium" : "text-muted-foreground",
              )}
            >
              {player.name ?? "Anon"}
              {isYou && " (you)"}
            </span>

            {/* Badges */}
            {isHost && (
              <span className="absolute -top-2 -right-2 text-[10px] bg-yellow-600 text-white px-1 rounded">
                Host
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
