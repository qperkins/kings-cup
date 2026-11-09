"use client";

import { useCallback, useEffect, useState } from "react";

export const BACKGROUNDS = [
  { id: "default", label: "Default", swatch: "oklch(0.8 0 0)" },
  { id: "ocean", label: "Ocean", swatch: "oklch(0.7 0.12 225)" },
  { id: "forest", label: "Forest", swatch: "oklch(0.65 0.12 155)" },
  { id: "sunset", label: "Sunset", swatch: "oklch(0.72 0.15 40)" },
  { id: "red", label: "Red", swatch: "oklch(0.64 0.2 22)" },
  { id: "pink", label: "Pink", swatch: "oklch(0.78 0.14 350)" },
  { id: "grape", label: "Grape", swatch: "oklch(0.62 0.15 305)" },
  { id: "midnight", label: "Navy", swatch: "oklch(0.3 0.09 250)" },
] as const;

export type BackgroundId = (typeof BACKGROUNDS)[number]["id"];

const STORAGE_KEY = "kings-cup-bg";

/** Per-player background choice, remembered in this browser only. */
export function useBackground(): [BackgroundId, (id: BackgroundId) => void] {
  const [bg, setBgState] = useState<BackgroundId>("default");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && BACKGROUNDS.some((b) => b.id === saved)) {
        // Read after mount so SSR and first client render match.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setBgState(saved as BackgroundId);
      }
    } catch {
      /* storage unavailable — keep default */
    }
  }, []);

  const setBg = useCallback((id: BackgroundId) => {
    setBgState(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  return [bg, setBg];
}

/** Class list for a page wrapper: the gradient, plus `dark` for the always-dark Midnight theme. */
export function pageClass(bg: BackgroundId, extra = ""): string {
  return ["page-bg", bg === "midnight" ? "dark" : "", extra].filter(Boolean).join(" ");
}
