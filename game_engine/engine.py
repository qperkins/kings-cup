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

import random
from dataclasses import dataclass
from uuid import uuid4

from .models import (
    ActionIntent,
    Battle,
    DrawCardIntent,
    EndGameIntent,
    GamePhase,
    GameState,
    JoinIntent,
    KickPlayerIntent,
    LeaveRoomIntent,
    MakeHostIntent,
    PendingInput,
    Player,
    RestartGameIntent,
    ResolveBattleIntent,
    ServerEvent,
    SetChallengeTypeIntent,
    SetQuickFlipIntent,
    StartGameIntent,
    SubmitBanIntent,
    SubmitRuleIntent,
    new_deck,
)

MAX_RULE_LEN = 120
MAX_WORD_LEN = 40


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
    elif isinstance(intent, SetQuickFlipIntent):
        result = _handle_set_quick_flip(state, intent)
    elif isinstance(intent, SetChallengeTypeIntent):
        result = _handle_set_challenge_type(state, intent)
    elif isinstance(intent, LeaveRoomIntent):
        result = _handle_leave(state, intent)
    elif isinstance(intent, KickPlayerIntent):
        result = _handle_kick(state, intent)
    elif isinstance(intent, MakeHostIntent):
        result = _handle_make_host(state, intent)
    elif isinstance(intent, SubmitRuleIntent):
        result = _handle_submit_rule(state, intent)
    elif isinstance(intent, SubmitBanIntent):
        result = _handle_submit_ban(state, intent)
    elif isinstance(intent, ResolveBattleIntent):
        result = _handle_resolve_battle(state, intent)
    elif isinstance(intent, RestartGameIntent):
        result = _handle_restart(state, intent)
    elif isinstance(intent, EndGameIntent):
        result = _handle_end(state, intent)
    else:  # pragma: no cover - exhaustiveness guard
        raise EngineError(f"Unknown intent type: {intent!r}")

    result.state.processed_action_ids.add(intent.action_id)
    return result


def _handle_join(state: GameState, intent: JoinIntent) -> EngineResult:
    # Reconnect path: resume_token matches an existing player -> rejoin their
    # seat instead of creating a duplicate. Allowed in any phase, since a
    # dropped connection shouldn't cost a player their spot.
    if intent.resume_token:
        if intent.resume_token in state.kicked_ids:
            raise EngineError("You were removed from this room")
        for existing in state.players:
            if existing.id == intent.resume_token:
                existing.connected = True
                return EngineResult(
                    state=state,
                    events=[ServerEvent(type="player_reconnected", payload=existing.model_dump())],
                )
        # Unknown token (e.g. left the room, or a token from another room):
        # treat as a brand-new player. Joining mid-game is allowed.

    # Seats are never reused or compacted: removals leave gaps, so the next seat
    # is max+1 (not len(players)), which can't collide with an existing seat.
    seat = max((p.seat for p in state.players), default=-1) + 1
    # Fresh joins always get a server-generated id; clients never choose their own.
    player = Player(id=str(uuid4()), name=intent.player_name, seat=seat)
    state.players.append(player)
    if state.host_id is None and len(state.players) == 1:
        state.host_id = player.id  # first joiner is the host

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
    state.current_turn_seat = _lowest_seat(state)

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

    if state.pending_input or state.battle:
        raise EngineError("Finish the current rule or battle first")

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
                "rule_text": card.rule_text(state.quick_flip_enabled),
                "cards_remaining": len(state.deck),
            },
        )
    ]

    if finished:
        events.append(ServerEvent(type="game_finished", payload={"kings_drawn": state.kings_drawn}))
        return EngineResult(state=state, events=events)

    # Jack / Queen need input or a battle before the turn moves on.
    rank = card.rank.value
    if rank == "J":
        state.pending_input = PendingInput(player_id=active.id, kind="word_ban")
    elif rank == "Q":
        others = [p for p in state.players if p.id != active.id]
        if state.quick_flip_enabled and others:
            state.battle = Battle(
                challenger_id=active.id,
                opponent_id=random.choice(others).id,
                challenge=state.challenge_type,
            )
        else:
            state.pending_input = PendingInput(player_id=active.id, kind="rule")

    if state.pending_input or state.battle:
        events.append(
            ServerEvent(
                type="input_required",
                payload={
                    "pending_input": state.pending_input.model_dump() if state.pending_input else None,
                    "battle": state.battle.model_dump() if state.battle else None,
                },
            )
        )
    else:
        events.append(_advance_turn(state))

    return EngineResult(state=state, events=events)


def _lowest_seat(state: GameState) -> int:
    return min((p.seat for p in state.players), default=0)


def _next_seat(state: GameState, after_seat: int) -> int:
    """Next occupied seat after `after_seat`, wrapping. Seats can have gaps
    (players leave), so never use modulo arithmetic on seat numbers."""
    seats = sorted(p.seat for p in state.players)
    if not seats:
        return 0
    for seat in seats:
        if seat > after_seat:
            return seat
    return seats[0]


def _advance_turn(state: GameState) -> ServerEvent:
    state.current_turn_seat = _next_seat(state, state.current_turn_seat)
    return ServerEvent(type="turn_advanced", payload={"current_turn_seat": state.current_turn_seat})


def _require_host(state: GameState, player_id: str) -> None:
    host = state.host()
    if host is None or host.id != player_id:
        raise EngineError("Only the host can do that")


def _handle_set_quick_flip(state: GameState, intent: SetQuickFlipIntent) -> EngineResult:
    _require_host(state, intent.player_id)
    if state.phase != GamePhase.LOBBY:
        raise EngineError("Settings can only change in the lobby")
    state.quick_flip_enabled = intent.enabled
    return EngineResult(
        state=state,
        events=[ServerEvent(type="settings_updated", payload={"quick_flip_enabled": intent.enabled})],
    )


def _handle_set_challenge_type(state: GameState, intent: SetChallengeTypeIntent) -> EngineResult:
    _require_host(state, intent.player_id)
    if state.phase != GamePhase.LOBBY:
        raise EngineError("Settings can only change in the lobby")
    state.challenge_type = intent.challenge_type
    return EngineResult(
        state=state,
        events=[
            ServerEvent(
                type="settings_updated",
                payload={
                    "quick_flip_enabled": state.quick_flip_enabled,
                    "challenge_type": state.challenge_type,
                },
            )
        ],
    )


def _remove_player(state: GameState, player_id: str, reason: str) -> list[ServerEvent]:
    """Take a player out of the room and repair anything that pointed at them:
    host, whose-turn-it-is, a pending rule/ban, and a Quick Flip battle."""
    leaving = state.player_by_id(player_id)
    if leaving is None:
        raise EngineError("Player is not in this room")

    was_host = state.host() is not None and state.host().id == player_id
    was_turn = state.phase == GamePhase.IN_PROGRESS and leaving.seat == state.current_turn_seat
    next_seat = _next_seat(state, leaving.seat)

    state.players = [p for p in state.players if p.id != player_id]
    events: list[ServerEvent] = []

    if reason == "kicked":
        state.kicked_ids.add(player_id)

    if was_host:
        new_host = min(state.players, key=lambda p: p.seat) if state.players else None
        state.host_id = new_host.id if new_host else None

    if state.phase == GamePhase.IN_PROGRESS:
        owed_input = state.pending_input is not None and state.pending_input.player_id == player_id
        in_battle = state.battle is not None and player_id in (
            state.battle.challenger_id,
            state.battle.opponent_id,
        )
        if owed_input:
            state.pending_input = None
        if in_battle:
            # Either battler leaving cancels it; nobody else can resolve it.
            state.battle = None

        if len(state.players) < 2:
            state.phase = GamePhase.FINISHED
            state.pending_input = None
            state.battle = None
            events.append(ServerEvent(type="game_finished", payload={"kings_drawn": state.kings_drawn}))
        elif was_turn:
            state.current_turn_seat = next_seat
        elif owed_input or in_battle:
            # The opponent left mid-battle: the drawer's turn is over now.
            state.current_turn_seat = _next_seat(state, state.current_turn_seat)

    removal = {"player_id": player_id, "reason": reason}
    return [ServerEvent(type="player_removed", payload={**state.to_client_view(), **removal})] + events


def _handle_leave(state: GameState, intent: LeaveRoomIntent) -> EngineResult:
    events = _remove_player(state, intent.player_id, "left")
    return EngineResult(state=state, events=events)


def _handle_kick(state: GameState, intent: KickPlayerIntent) -> EngineResult:
    _require_host(state, intent.player_id)
    if intent.target_id == intent.player_id:
        raise EngineError("You can't remove yourself; leave the room instead")
    events = _remove_player(state, intent.target_id, "kicked")
    return EngineResult(state=state, events=events)


def _handle_make_host(state: GameState, intent: MakeHostIntent) -> EngineResult:
    _require_host(state, intent.player_id)
    if intent.target_id == intent.player_id:
        raise EngineError("You are already the host")
    target = state.player_by_id(intent.target_id)
    if target is None:
        raise EngineError("Player is not in this room")
    state.host_id = target.id
    return EngineResult(
        state=state,
        events=[ServerEvent(type="host_changed", payload={"host_id": target.id})],
    )


def _require_pending(state: GameState, player_id: str, kind: str) -> None:
    pending = state.pending_input
    if pending is None or pending.kind != kind:
        raise EngineError("Nothing to submit right now")
    if pending.player_id != player_id:
        raise EngineError("It is not your turn to submit")


def _handle_submit_rule(state: GameState, intent: SubmitRuleIntent) -> EngineResult:
    _require_pending(state, intent.player_id, "rule")
    text = " ".join(intent.text.split())[:MAX_RULE_LEN]
    if not text:
        raise EngineError("Rule cannot be empty")
    state.rules.append(text)
    state.pending_input = None
    return EngineResult(
        state=state,
        events=[
            ServerEvent(type="rule_added", payload={"player_id": intent.player_id, "text": text}),
            _advance_turn(state),
        ],
    )


def _handle_submit_ban(state: GameState, intent: SubmitBanIntent) -> EngineResult:
    _require_pending(state, intent.player_id, "word_ban")
    word = " ".join(intent.word.split())[:MAX_WORD_LEN]
    if not word:
        raise EngineError("Word cannot be empty")
    if word.lower() in (w.lower() for w in state.banned_words):
        raise EngineError("That word is already banned")
    state.banned_words.append(word)
    state.pending_input = None
    return EngineResult(
        state=state,
        events=[
            ServerEvent(type="word_banned", payload={"player_id": intent.player_id, "word": word}),
            _advance_turn(state),
        ],
    )


def _handle_resolve_battle(state: GameState, intent: ResolveBattleIntent) -> EngineResult:
    battle = state.battle
    if battle is None:
        raise EngineError("No battle in progress")
    if intent.player_id != battle.challenger_id:
        raise EngineError("Only the challenger can report the result")
    if intent.loser_id not in (None, battle.challenger_id, battle.opponent_id):
        raise EngineError("Loser must be one of the battlers")
    state.battle = None
    return EngineResult(
        state=state,
        events=[
            ServerEvent(type="battle_resolved", payload={"loser_id": intent.loser_id}),
            _advance_turn(state),
        ],
    )


def _handle_restart(state: GameState, intent: RestartGameIntent) -> EngineResult:
    _require_host(state, intent.player_id)
    if state.phase == GamePhase.LOBBY:
        raise EngineError("Game has not started")
    if len(state.players) < 2:
        raise EngineError("Need at least 2 players to restart")
    state.deck = new_deck()
    state.drawn_pile = []
    state.kings_drawn = 0
    state.current_turn_seat = _lowest_seat(state)
    state.rules = []
    state.banned_words = []
    state.pending_input = None
    state.battle = None
    state.phase = GamePhase.IN_PROGRESS
    return EngineResult(
        state=state,
        events=[ServerEvent(type="game_restarted", payload=state.to_client_view())],
    )


def _handle_end(state: GameState, intent: EndGameIntent) -> EngineResult:
    _require_host(state, intent.player_id)
    if state.phase != GamePhase.IN_PROGRESS:
        raise EngineError("Game is not in progress")
    state.phase = GamePhase.FINISHED
    state.pending_input = None
    state.battle = None
    return EngineResult(
        state=state,
        events=[ServerEvent(type="game_finished", payload={"kings_drawn": state.kings_drawn})],
    )
