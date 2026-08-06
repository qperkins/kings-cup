"""
Server-authoritative game engine.

Design principle: clients never mutate state directly. They send an
ActionIntent describing what they *want* to happen; this module decides
whether it's legal, applies it, and returns the events to broadcast.

This is the piece that turns "party game" into "systems demo" — the
deck order, whose turn it is, and what card was drawn are all decided
here, never trusted from the client.
"""
from __future__ import annotations

from dataclasses import dataclass

from .models import (
    ActionIntent,
    DrawCardIntent,
    GamePhase,
    GameState,
    JoinIntent,
    Player,
    ServerEvent,
    StartGameIntent,
    new_deck,
)


class EngineError(Exception):
    """Raised when an intent is illegal given current state.
    Callers should turn this into an error event back to the requesting
    client only — not broadcast it to the room."""


@dataclass
class EngineResult:
    state: GameState
    events: list[ServerEvent]


def apply_intent(state: GameState, intent: ActionIntent) -> EngineResult:
    # Idempotency: if we've already processed this action_id, replay is a no-op.
    # Handles double-taps and client retries on flaky mobile connections without
    # double-drawing a card or double-joining a player.
    if intent.action_id in state.processed_action_ids:
        return EngineResult(state=state, events=[])

    if isinstance(intent, JoinIntent):
        result = _handle_join(state, intent)
    elif isinstance(intent, StartGameIntent):
        result = _handle_start(state, intent)
    elif isinstance(intent, DrawCardIntent):
        result = _handle_draw(state, intent)
    else:  # pragma: no cover - exhaustiveness guard
        raise EngineError(f"Unknown intent type: {intent!r}")

    result.state.processed_action_ids.add(intent.action_id)
    return result


def _handle_join(state: GameState, intent: JoinIntent) -> EngineResult:
    # Reconnect path: resume_token matches an existing player -> rejoin their
    # seat instead of creating a duplicate. This is allowed even mid-game,
    # since a dropped connection shouldn't cost a player their spot.
    if intent.resume_token:
        for existing in state.players:
            if existing.id == intent.resume_token:
                existing.connected = True
                return EngineResult(
                    state=state,
                    events=[ServerEvent(type="player_reconnected", payload=existing.model_dump())],
                )
        # resume_token provided but unknown -> fall through and treat as a
        # fresh join only if the lobby is still open; otherwise reject.

    if state.phase != GamePhase.LOBBY:
        raise EngineError("Cannot join — game already in progress")

    seat = len(state.players)
    player = Player(id=_player_id(intent), name=intent.player_name, seat=seat)
    state.players.append(player)

    return EngineResult(
        state=state,
        events=[ServerEvent(type="player_joined", payload=player.model_dump())],
    )


def _handle_start(state: GameState, intent: StartGameIntent) -> EngineResult:
    if state.phase != GamePhase.LOBBY:
        raise EngineError("Game already started")
    if len(state.players) < 2:
        raise EngineError("Need at least 2 players to start")

    state.deck = new_deck()
    state.phase = GamePhase.IN_PROGRESS
    state.current_turn_seat = 0

    return EngineResult(
        state=state,
        events=[ServerEvent(type="game_started", payload={"player_count": len(state.players)})],
    )


def _handle_draw(state: GameState, intent: DrawCardIntent) -> EngineResult:
    if state.phase != GamePhase.IN_PROGRESS:
        raise EngineError("Game is not in progress")

    active = state.active_player()
    if active is None or active.id != intent.player_id:
        raise EngineError("It is not your turn")

    if not state.deck:
        raise EngineError("Deck is empty")

    card = state.deck.pop()
    state.drawn_pile.append(card)

    if card.rank.value == "K":
        state.kings_drawn += 1

    finished = state.kings_drawn >= 4 or not state.deck
    if finished:
        state.phase = GamePhase.FINISHED

    events = [
        ServerEvent(
            type="card_drawn",
            payload={
                "player_id": active.id,
                "card": card.model_dump(),
                "rule_text": card.rule_text(),
                "cards_remaining": len(state.deck),
            },
        )
    ]

    if finished:
        events.append(ServerEvent(type="game_finished", payload={"kings_drawn": state.kings_drawn}))
    else:
        state.current_turn_seat = (state.current_turn_seat + 1) % len(state.players)
        events.append(
            ServerEvent(
                type="turn_advanced",
                payload={"current_turn_seat": state.current_turn_seat},
            )
        )

    return EngineResult(state=state, events=events)


def _player_id(intent: JoinIntent) -> str:
    # Reused as the resume identity on reconnect — see connection_manager.
    from uuid import uuid4
    return intent.resume_token or str(uuid4())
