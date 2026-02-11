"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import {
  CARD_VIEWBOX,
  CARD_SPRING,
  CARD_BACK_HREF,
  getCardHref,
} from "./card-utils";

interface PlayingCardProps {
  rank?: string;
  suit?: string;
  /** When true the card back is shown instead of the face. */
  faceDown?: boolean;
  /** Unique layout ID for Motion magic-move transitions. */
  layoutId?: string;
  className?: string;
  /** Disables hover lift */
  disableHover?: boolean;
  onClick?: () => void;
}

export function PlayingCard({
  rank,
  suit,
  faceDown = false,
  layoutId,
  className,
  disableHover = false,
  onClick,
}: PlayingCardProps) {
  const href =
    faceDown || !rank || !suit ? CARD_BACK_HREF : getCardHref(rank, suit);

  return (
    <motion.div
      layoutId={layoutId}
      className={cn(
        "inline-block rounded-lg overflow-hidden shadow-lg select-none",
        onClick && "cursor-pointer",
        className,
      )}
      whileHover={disableHover ? undefined : { y: -4 }}
      whileTap={onClick ? { scale: 0.95 } : undefined}
      transition={CARD_SPRING}
      onClick={onClick}
    >
      <svg
        viewBox={CARD_VIEWBOX}
        className="block w-full h-full"
        aria-label={faceDown ? "Card back" : `${rank} of ${suit}`}
      >
        <use href={href} />
      </svg>
    </motion.div>
  );
}
