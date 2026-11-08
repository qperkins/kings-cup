"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface RulesPanelProps {
  rules: string[];
  bannedWords: string[];
}

/** Collapsible list of rules and banned words created during this game. */
export function RulesPanel({ rules, bannedWords }: RulesPanelProps) {
  const [open, setOpen] = useState(true);
  const count = rules.length + bannedWords.length;
  if (count === 0) return null;

  return (
    <div className="w-full max-w-xs rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-2 text-sm font-semibold"
      >
        <span>Rules ({count})</span>
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-3 border-t px-4 py-3 text-sm">
          {rules.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Queen&apos;s Rules</p>
              <ul className="list-disc space-y-1 pl-4">
                {rules.map((r, i) => (
                  <li key={`${i}-${r}`} className="break-words">{r}</li>
                ))}
              </ul>
            </div>
          )}
          {bannedWords.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                Jack&apos;s Trap — banned words
              </p>
              <div className="flex flex-wrap gap-1.5">
                {bannedWords.map((w) => (
                  <span
                    key={w}
                    className="max-w-full break-all rounded-full bg-destructive/10 px-2 py-0.5 text-destructive line-through"
                  >
                    {w}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
