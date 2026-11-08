"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface PlayerActionsProps {
  playerName: string;
  onMakeHost: () => Promise<unknown>;
  onKick: () => Promise<unknown>;
}

/** Host-only per-player menu: hand over the host role or remove the player. */
export function PlayerActions({ playerName, onMakeHost, onKick }: PlayerActionsProps) {
  const [open, setOpen] = useState(false);
  const [confirmKick, setConfirmKick] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setConfirmKick(false);
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      close();
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`Manage ${playerName}`}
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="rounded px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 flex w-36 flex-col gap-1 rounded-lg border bg-card p-1 shadow-md"
        >
          <Button
            role="menuitem"
            variant="ghost"
            size="sm"
            className="justify-start"
            disabled={busy}
            onClick={() => void run(onMakeHost)}
          >
            Make host
          </Button>
          {confirmKick ? (
            <Button
              role="menuitem"
              variant="destructive"
              size="sm"
              className="justify-start"
              disabled={busy}
              onClick={() => void run(onKick)}
            >
              Confirm remove
            </Button>
          ) : (
            <Button
              role="menuitem"
              variant="ghost"
              size="sm"
              className="justify-start text-destructive"
              disabled={busy}
              onClick={() => setConfirmKick(true)}
            >
              Remove
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
