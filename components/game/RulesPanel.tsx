"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface RulesPanelProps {
  /** Queen's Rules created this game. */
  rules: string[];
  /** Jack's Trap words banned this game. */
  bannedWords: string[];
  /** Drinking-mate links created this game. */
  mates?: [string, string][];
  nameOf?: (id: string) => string;
  /** The viewing player, so their own mates are highlighted. */
  youId?: string;
}

interface SectionProps {
  icon: string;
  title: string;
  hint: string;
  count: number;
  accent: string;
  children: ReactNode;
}

/** One labelled block: title + count, a one-line "how it works", then its items. */
function Section({ icon, title, hint, count, accent, children }: SectionProps) {
  return (
    <section className={cn("rounded-md border border-l-4 bg-background/60 p-3", accent)}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-bold">
          <span aria-hidden>{icon}</span>
          {title}
        </h4>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums">
          {count}
        </span>
      </div>
      <p className="mb-2 mt-0.5 text-xs text-muted-foreground">{hint}</p>
      {children}
    </section>
  );
}

/** Collapsible "Table Rules": Queen's Rules, Jack's banned words and drinking mates, in separate sections. */
export function RulesPanel({
  rules,
  bannedWords,
  mates = [],
  nameOf = (id) => id,
  youId,
}: RulesPanelProps) {
  const [open, setOpen] = useState(true);
  const count = rules.length + bannedWords.length + mates.length;
  if (count === 0) return null;

  const summary = [
    rules.length > 0 && `\u{1F4DC} ${rules.length}`,
    bannedWords.length > 0 && `\u{1F6AB} ${bannedWords.length}`,
    mates.length > 0 && `❤️ ${mates.length}`,
  ].filter(Boolean);

  return (
    <div className="w-full max-w-xs rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-2 text-sm font-semibold"
      >
        <span>Table Rules</span>
        <span className="ml-auto flex gap-2 text-xs font-medium text-muted-foreground">
          {summary.map((s) => (
            <span key={String(s)}>{s}</span>
          ))}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="space-y-3 border-t px-3 py-3 text-sm">
          {rules.length > 0 && (
            <Section
              icon={"\u{1F4DC}"}
              title="Queen's Rules"
              hint="Break one and you take a drink."
              count={rules.length}
              accent="border-l-yellow-500"
            >
              <ol className="list-decimal space-y-1 pl-5">
                {rules.map((r, i) => (
                  <li key={`${i}-${r}`} className="break-words">
                    {r}
                  </li>
                ))}
              </ol>
            </Section>
          )}

          {bannedWords.length > 0 && (
            <Section
              icon={"\u{1F6AB}"}
              title="Jack's Trap"
              hint="Say a banned word and you take a drink."
              count={bannedWords.length}
              accent="border-l-red-500"
            >
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
            </Section>
          )}

          {mates.length > 0 && (
            <Section
              icon={"❤️"}
              title="Drinking Mates"
              hint="When one mate drinks, the other drinks too."
              count={mates.length}
              accent="border-l-pink-500"
            >
              <ul className="space-y-1">
                {mates.map(([a, b]) => {
                  const mine = youId !== undefined && (a === youId || b === youId);
                  return (
                    <li
                      key={`${a}-${b}`}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded px-2 py-1",
                        mine ? "bg-pink-500/15 font-semibold" : "bg-muted/60",
                      )}
                    >
                      <span className="break-words">
                        {a === youId ? "You" : nameOf(a)}{" "}
                        <span aria-label="mates with">&#10084;&#65039;</span>{" "}
                        {b === youId ? "You" : nameOf(b)}
                      </span>
                      {mine && <span className="text-xs text-pink-700 dark:text-pink-300">yours</span>}
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
