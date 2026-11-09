"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Reorder, useDragControls } from "motion/react";
import { PlayerActions } from "./PlayerActions";
import type { Player } from "@/lib/game/types";
import { rosterKey } from "@/lib/game/rosterKey";

interface LobbyPlayerListProps {
  /** Players in server order (sorted by seat). */
  players: Player[];
  playerId: string | null;
  hostId: string | null;
  /** True for the host: shows drag handles and the randomize button. */
  canReorder: boolean;
  onReorder: (order: string[]) => Promise<{ success: boolean }>;
  onShuffle: () => Promise<unknown>;
  onMakeHost: (id: string) => Promise<unknown>;
  onKick: (id: string) => Promise<unknown>;
}

interface RowProps {
  player: Player;
  index: number;
  isYou: boolean;
  isHostPlayer: boolean;
  canReorder: boolean;
  showActions: boolean;
  onDragEnd: () => void;
  onMakeHost: () => Promise<unknown>;
  onKick: () => Promise<unknown>;
}

function Row({
  player,
  index,
  isYou,
  isHostPlayer,
  canReorder,
  showActions,
  onDragEnd,
  onMakeHost,
  onKick,
}: RowProps) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      as="div"
      value={player.id}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDragEnd}
      whileDrag={{ scale: 1.03, boxShadow: "0 8px 24px rgba(0,0,0,0.25)", zIndex: 10 }}
      className="relative flex items-center justify-between rounded-lg border bg-muted/50 p-3"
    >
      <div className="flex items-center gap-3">
        {canReorder && (
          <button
            type="button"
            aria-label={`Drag to reorder ${player.name}`}
            className="cursor-grab touch-none select-none px-1 text-lg text-muted-foreground active:cursor-grabbing"
            style={{ touchAction: "none" }}
            onPointerDown={(e) => controls.start(e)}
          >
            &#9776;
          </button>
        )}
        <span className="w-4 text-center text-xs text-muted-foreground">{index + 1}</span>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary font-medium text-primary-foreground">
          {player.name.charAt(0).toUpperCase()}
        </div>
        <span className="font-medium">
          {player.name}
          {isYou && <span className="ml-2 text-muted-foreground">(you)</span>}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {index === 0 && (
          <span className="cue-bg rounded px-2 py-0.5 text-xs font-bold">
            Goes first
          </span>
        )}
        {isHostPlayer && (
          <span className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground">
            Host
          </span>
        )}
        {showActions && (
          <PlayerActions playerName={player.name} onMakeHost={onMakeHost} onKick={onKick} />
        )}
      </div>
    </Reorder.Item>
  );
}

/** Lobby roster. The host can drag rows (or randomize) to set turn order. */
export function LobbyPlayerList({
  players,
  playerId,
  hostId,
  canReorder,
  onReorder,
  onShuffle,
  onMakeHost,
  onKick,
}: LobbyPlayerListProps) {
  const serverOrder = useMemo(() => players.map((p) => p.id), [players]);
  const serverKey = serverOrder.join(",");
  // Optimistic order while/after dragging. It remembers which server order it was
  // based on, so it is ignored automatically once the server sends a new one.
  const [local, setLocalState] = useState<{ base: string; ids: string[] } | null>(null);
  const localRef = useRef<{ base: string; ids: string[] } | null>(null);
  const setLocal = useCallback((value: { base: string; ids: string[] } | null) => {
    localRef.current = value;
    setLocalState(value);
  }, []);

  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const ids = useMemo(() => {
    if (!local || local.base !== serverKey) return serverOrder;
    const known = local.ids.filter((id) => byId.has(id));
    const missing = serverOrder.filter((id) => !known.includes(id));
    return [...known, ...missing];
  }, [local, serverKey, serverOrder, byId]);

  const commit = async () => {
    const current = localRef.current;
    if (!current || current.base !== serverKey) return;
    if (current.ids.join(",") === serverKey) return;
    const result = await onReorder(current.ids);
    if (!result.success) setLocal(null); // roll back to the server's order
  };

  return (
    <div className="space-y-2">
      {/* Keyed by roster membership: when someone joins/leaves mid-drag, Motion would leave
          the dragged row stuck at scale(1.03) (overlapping, and blocking, the row below).
          Remounting on a membership change ends the drag cleanly. */}
      <Reorder.Group
        key={rosterKey(serverOrder)}
        as="div"
        axis="y"
        values={ids}
        onReorder={(order: string[]) => setLocal({ base: serverKey, ids: order })}
        className="space-y-2"
      >
        {ids.map((id, index) => {
          const player = byId.get(id);
          if (!player) return null;
          return (
            <Row
              key={id}
              player={player}
              index={index}
              isYou={id === playerId}
              isHostPlayer={id === hostId}
              canReorder={canReorder}
              showActions={canReorder && id !== playerId}
              onDragEnd={() => void commit()}
              onMakeHost={() => onMakeHost(id)}
              onKick={() => onKick(id)}
            />
          );
        })}
      </Reorder.Group>
      {canReorder && players.length > 1 && (
        <button
          type="button"
          className="w-full rounded-lg border border-dashed py-2 text-sm font-medium hover:bg-muted/60"
          onClick={() => void onShuffle()}
        >
          &#128256; Randomize order
        </button>
      )}
      {canReorder && players.length > 1 && (
        <p className="text-center text-xs text-muted-foreground">
          Drag &#9776; to set turn order. Player 1 draws first.
        </p>
      )}
    </div>
  );
}
