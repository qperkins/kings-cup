"use client";

import { cn } from "@/lib/utils";
import { WILD_CARDS } from "./wild-cards";

interface WildCardProps {
  wildId: string;
  className?: string;
  /** Play the one-shot reveal (flash + slam + shimmer). CSS-only, transform/opacity only. */
  reveal?: boolean;
}

/**
 * A Royal Mayhem "Court of Chaos" card: pure CSS (no sprite, no images), deliberately
 * unlike the white standard cards. Same 169:245 aspect ratio as PlayingCard.
 */
export function WildCard({ wildId, className, reveal = false }: WildCardProps) {
  const def = WILD_CARDS[wildId];
  if (!def) return null;
  const isKing = wildId.startsWith("king_chaos");

  return (
    <div className={cn("relative aspect-[169/245] w-full select-none", className)}>
      {reveal && (
        <div
          aria-hidden
          className="wild-flash pointer-events-none absolute -inset-10 rounded-full opacity-0"
          style={{
            background:
              "radial-gradient(circle, rgba(250,204,21,0.85) 0%, rgba(147,51,234,0.55) 45%, transparent 70%)",
          }}
        />
      )}
      <div
        className={cn(
          "relative flex h-full w-full flex-col items-center justify-between overflow-hidden rounded-lg border-2 p-2 text-center shadow-xl",
          reveal && "wild-slam",
        )}
        style={{
          borderColor: "#facc15",
          background:
            "linear-gradient(155deg, #2e1065 0%, #6d28d9 52%, #1e1b4b 100%)",
          boxShadow: "0 0 0 2px #4c1d95 inset, 0 10px 24px rgba(88,28,135,0.5)",
        }}
        aria-label={`${def.name} wildcard`}
      >
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-yellow-300">
          {isKing ? "Chaos" : "Wild"}
        </span>
        <span className="text-5xl leading-none drop-shadow" aria-hidden>
          {def.emoji}
        </span>
        <div>
          <p className="text-sm font-extrabold leading-tight text-yellow-200">{def.name}</p>
          <p className="mt-0.5 text-[10px] leading-tight text-purple-200">{def.tagline}</p>
        </div>
        {reveal && (
          <div
            aria-hidden
            className="wild-shimmer pointer-events-none absolute inset-y-0 left-0 w-1/3 -translate-x-full"
            style={{
              background:
                "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)",
            }}
          />
        )}
      </div>
    </div>
  );
}
