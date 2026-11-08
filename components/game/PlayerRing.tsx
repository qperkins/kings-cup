"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { PlayerActions } from "./PlayerActions";

interface Player {
  userId: string;
  name: string | null;
}

interface PlayerRingProps {
  players: Player[];
  currentPlayerId: string | null;
  userId: string;
  hostId: string | null;
  /** Passed only to the host; shows a per-player menu for everyone else. */
  onMakeHost?: (playerId: string) => Promise<unknown>;
  onKick?: (playerId: string) => Promise<unknown>;
}

export function PlayerRing({
  players,
  currentPlayerId,
  userId,
  hostId,
  onMakeHost,
  onKick,
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
            className="relative flex flex-col items-center gap-1 mx-2"
          >
            {/* Animated turn indicator ring */}
            {isCurrent && (
              <motion.div
                layoutId="turn-indicator"
                className="absolute -inset-1 rounded p-4 border-2 border-primary shadow-[0_0_12px_hsl(var(--primary)/0.5)]"
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
                isCurrent
                  ? "text-foreground font-medium"
                  : "text-muted-foreground",
              )}
            >
              {player.name ?? "Anon"}
              {isYou && " (you)"}
            </span>

            {onMakeHost && onKick && !isYou && (
              <PlayerActions
                playerName={player.name ?? "player"}
                onMakeHost={() => onMakeHost(player.userId)}
                onKick={() => onKick(player.userId)}
              />
            )}

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
