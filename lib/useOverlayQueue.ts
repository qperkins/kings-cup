"use client";

import { useCallback, useEffect, useState } from "react";

export interface OverlayItemBase {
  /** Unique per item; used to restart the auto-dismiss timer. */
  key: string;
  /** Items of the same kind waiting in the queue are replaced by the newest. */
  kind: string;
  /** Auto-dismiss delay in ms. Use Infinity to require a tap. */
  duration: number;
}

/**
 * Single-slot overlay queue: shows one popup at a time, auto-dismisses it
 * after `duration`, then shows the next. A tap calls `dismiss`.
 */
export function useOverlayQueue<T extends OverlayItemBase>() {
  const [queue, setQueue] = useState<T[]>([]);
  const current = queue[0] ?? null;

  const push = useCallback((item: T) => {
    setQueue((q) => [
      ...q.filter((existing, i) => i === 0 || existing.kind !== item.kind),
      item,
    ]);
  }, []);

  const dismiss = useCallback(() => setQueue((q) => q.slice(1)), []);
  const clear = useCallback(() => setQueue([]), []);

  const key = current?.key;
  const duration = current?.duration;
  useEffect(() => {
    if (key === undefined || duration === undefined || !Number.isFinite(duration)) return;
    const t = setTimeout(dismiss, duration);
    return () => clearTimeout(t);
  }, [key, duration, dismiss]);

  return { current, push, dismiss, clear };
}
