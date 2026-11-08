"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";
import { BACKGROUNDS, type BackgroundId } from "@/lib/useBackground";

interface BackgroundPickerProps {
  value: BackgroundId;
  onChange: (id: BackgroundId) => void;
  className?: string;
}

/** Swatch radio group. One tab stop; arrow keys move and select (WAI-ARIA radio pattern). */
export function BackgroundPicker({ value, onChange, className }: BackgroundPickerProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1
      : 0;
    if (!step) return;
    e.preventDefault();
    const next = BACKGROUNDS[(index + step + BACKGROUNDS.length) % BACKGROUNDS.length];
    onChange(next.id);
    refs.current[next.id]?.focus();
  };

  return (
    <div
      className={cn("flex items-center gap-2", className)}
      role="radiogroup"
      aria-label="Background color"
    >
      {BACKGROUNDS.map((b, i) => (
        <button
          key={b.id}
          ref={(el) => {
            refs.current[b.id] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === b.id}
          aria-label={b.label}
          title={b.label}
          tabIndex={value === b.id ? 0 : -1}
          onClick={() => onChange(b.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
          style={{ backgroundColor: b.swatch }}
          className={cn(
            "h-7 w-7 rounded-full border border-foreground/30 transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            value === b.id ? "scale-110 ring-2 ring-foreground" : "hover:scale-110",
          )}
        />
      ))}
    </div>
  );
}
