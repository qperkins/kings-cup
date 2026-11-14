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
    WILD_DRINK,
    ActionIntent,
    Battle,
    BreakMateIntent,
    Card,
    ChooseMateIntent,
    ChooseTargetIntent,
    DrawCardIntent,
    KINGS_TO_END,
    EndGameIntent,
    GamePhase,
    GameState,
    JoinIntent,
    KickPlayerIntent,
    LeaveRoomIntent,
    MakeHostIntent,
    PendingInput,
    Player,
    ReorderPlayersIntent,
    RestartGameIntent,
    ResolveBattleIntent,
    ReturnToLobbyIntent,
    ServerEvent,
    SetChallengeTypeIntent,
    SetGameModeIntent,
    SetQuickFlipIntent,
    ShufflePlayersIntent,
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
    elif isinstance(intent, ReorderPlayersIntent):
        result = _handle_reorder_players(state, intent)
    elif isinstance(intent, ShufflePlayersIntent):
        result = _handle_shuffle_players(state, intent)
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
    elif isinstance(intent, ChooseMateIntent):
        result = _handle_choose_mate(state, intent)
    elif isinstance(intent, ChooseTargetIntent):
        result = _handle_choose_target(state, intent)
    elif isinstance(intent, BreakMateIntent):
        result = _handle_break_mate(state, intent)
    elif isinstance(intent, SetGameModeIntent):
        result = _handle_set_game_mode(state, intent)
    elif isinstance(intent, ResolveBattleIntent):
        result = _handle_resolve_battle(state, intent)
    elif isinstance(intent, RestartGameIntent):
        result = _handle_restart(state, intent)
    elif isinstance(intent, EndGameIntent):
        result = _handle_end(state, intent)
    elif isinstance(intent, ReturnToLobbyIntent):
        result = _handle_return_to_lobby(state, intent)
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

    state.deck = new_deck(state.game_mode)
    state.direction = 1
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

    if card.is_king:
        state.kings_drawn += 1

    finished = state.kings_drawn >= KINGS_TO_END[state.game_mode] or not state.deck
    if finished:
        state.phase = GamePhase.FINISHED

    rule_text = card.rule_text(state.quick_flip_enabled)
    if card.wild_id == "exile":
        # Name the skipped player in the popup (the generic text can't know them).
        skipped = state.player_by_id(_player_at_seat(state, _next_seat(state, active.seat)))
        if skipped is not None:
            rule_text = f"Exile — {skipped.name} is skipped and takes {WILD_DRINK}"

    events = [
        ServerEvent(
            type="card_drawn",
            payload={
                "player_id": active.id,
                "card": card.model_dump(),
                "rule_text": rule_text,
                "cards_remaining": len(state.deck),
            },
        )
    ]

    if finished:
        events.append(ServerEvent(type="game_finished", payload={"kings_drawn": state.kings_drawn}))
        return EngineResult(state=state, events=events)

    if card.is_wild:
        events.extend(_apply_wild(state, card, active))
        return EngineResult(state=state, events=events)

    # Jack / Queen need input or a battle before the turn moves on.
    rank = card.rank.value if card.rank else ""
    if rank == "J":
        state.pending_input = PendingInput(player_id=active.id, kind="word_ban")
    elif rank == "8":
        # Only ask for a mate if there is someone the drawer isn't linked to yet.
        if _mate_candidates(state, active.id):
            state.pending_input = PendingInput(player_id=active.id, kind="mate")
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
        events.append(_input_required_event(state))
    else:
        events.append(_advance_turn(state))

    return EngineResult(state=state, events=events)


def _input_required_event(state: GameState) -> ServerEvent:
    return ServerEvent(
        type="input_required",
        payload={
            "pending_input": state.pending_input.model_dump() if state.pending_input else None,
            "battle": state.battle.model_dump() if state.battle else None,
        },
    )


def _apply_wild(state: GameState, card: Card, active: Player) -> list[ServerEvent]:
    """Effects of the Royal Mayhem wildcards. Anything not listed here (Jester's Folly,
    Plague of Thirst, Royal Pardon, Decree of Silence, King of Chaos) is resolved by the
    table, like most classic rules: the card text tells everyone what to do."""
    wid = card.wild_id
    others = [p for p in state.players if p.id != active.id]

    if wid == "reverse":
        state.direction = -state.direction
        return [
            ServerEvent(type="direction_changed", payload={"direction": state.direction}),
            _advance_turn(state),
        ]

    if wid == "exile":
        # Skip the next player (they drink — see the rule text) and land on the one after.
        state.current_turn_seat = _next_seat(state, state.current_turn_seat)
        exiled = state.active_player()
        events = [ServerEvent(type="player_exiled", payload={"player_id": exiled.id if exiled else None})]
        events.append(_advance_turn(state))
        return events

    if wid == "encore":
        return []  # same player, same turn: they simply draw again

    if wid == "scepter":
        if others:
            state.battle = Battle(
                challenger_id=active.id,
                opponent_id=random.choice(others).id,
                challenge=state.challenge_type,
                kind="rps",
            )
            return [_input_required_event(state)]
        return [_advance_turn(state)]

    if wid == "duel":
        if others:
            state.pending_input = PendingInput(player_id=active.id, kind="duel")
            return [_input_required_event(state)]
        return [_advance_turn(state)]

    if wid == "treason":
        if state.mates:
            state.pending_input = PendingInput(player_id=active.id, kind="treason")
            return [_input_required_event(state)]
        return [_advance_turn(state)]  # no mate pairs to break

    return [_advance_turn(state)]


def _are_mates(state: GameState, a: str, b: str) -> bool:
    return any({a, b} == set(pair) for pair in state.mates)


def _mate_candidates(state: GameState, drawer_id: str) -> list[Player]:
    """Players the drawer could still pair with (not self, not already mates)."""
    return [
        p for p in state.players
        if p.id != drawer_id and not _are_mates(state, drawer_id, p.id)
    ]


def _pending_unfulfillable(state: GameState) -> bool:
    pending = state.pending_input
    if pending is None:
        return False
    if pending.kind == "mate":
        return not _mate_candidates(state, pending.player_id)
    if pending.kind == "treason":
        return not state.mates
    return False


def _lowest_seat(state: GameState) -> int:
    return min((p.seat for p in state.players), default=0)


def _next_seat(state: GameState, after_seat: int) -> int:
    """Next occupied seat after `after_seat` in the current direction, wrapping.
    Seats can have gaps (players leave), so never use modulo arithmetic on seats."""
    seats = sorted(p.seat for p in state.players)
    if not seats:
        return 0
    if state.direction < 0:
        for seat in reversed(seats):
            if seat < after_seat:
                return seat
        return seats[-1]
    for seat in seats:
        if seat > after_seat:
            return seat
    return seats[0]


def _player_at_seat(state: GameState, seat: int) -> str:
    for p in state.players:
        if p.seat == seat:
            return p.id
    return ""


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


def _handle_set_game_mode(state: GameState, intent: SetGameModeIntent) -> EngineResult:
    _require_host(state, intent.player_id)
    if state.phase != GamePhase.LOBBY:
        raise EngineError("Settings can only change in the lobby")
    state.game_mode = intent.mode
    return EngineResult(
        state=state,
        events=[
            ServerEvent(
                type="settings_updated",
                payload={
                    "quick_flip_enabled": state.quick_flip_enabled,
                    "challenge_type": state.challenge_type,
                    "game_mode": state.game_mode,
                },
            )
        ],
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


def _apply_order(state: GameState, ordered_ids: list[str]) -> EngineResult:
    """Reassign seats 0..n-1 in the given order (also compacts seat gaps)."""
    by_id = {p.id: p for p in state.players}
    for seat, pid in enumerate(ordered_ids):
        by_id[pid].seat = seat
    state.players = [by_id[pid] for pid in ordered_ids]
    return EngineResult(
        state=state,
        events=[
            ServerEvent(
                type="players_reordered",
                payload={"players": [p.model_dump() for p in state.players]},
            )
        ],
    )


def _handle_reorder_players(state: GameState, intent: ReorderPlayersIntent) -> EngineResult:
    _require_host(state, intent.player_id)
    if state.phase != GamePhase.LOBBY:
        raise EngineError("Player order can only change in the lobby")
    current_ids = {p.id for p in state.players}
    if len(intent.order) != len(set(intent.order)) or set(intent.order) != current_ids:
        raise EngineError("Order must list every player exactly once")
    return _apply_order(state, list(intent.order))


def _handle_shuffle_players(state: GameState, intent: ShufflePlayersIntent) -> EngineResult:
    _require_host(state, intent.player_id)
    if state.phase != GamePhase.LOBBY:
        raise EngineError("Player order can only change in the lobby")
    ids = [p.id for p in sorted(state.players, key=lambda p: p.seat)]
    random.shuffle(ids)
    return _apply_order(state, ids)


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
        # Links to a departed player are meaningless; drop them.
        state.mates = [pair for pair in state.mates if player_id not in pair]
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
        elif _pending_unfulfillable(state):
            # The drawer's only possible mate/target left, or no mate pair is left to
            # break: nothing to pick, so move on.
            state.pending_input = None
            state.current_turn_seat = _next_seat(state, state.current_turn_seat)
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


def _handle_choose_mate(state: GameState, intent: ChooseMateIntent) -> EngineResult:
    _require_pending(state, intent.player_id, "mate")
    if intent.mate_id == intent.player_id:
        raise EngineError("You can't be your own mate")
    if state.player_by_id(intent.mate_id) is None:
        raise EngineError("Player is not in this room")
    if _are_mates(state, intent.player_id, intent.mate_id):
        raise EngineError("You are already mates")
    state.mates.append([intent.player_id, intent.mate_id])
    state.pending_input = None
    return EngineResult(
        state=state,
        events=[
            ServerEvent(
                type="mate_chosen",
                payload={"player_id": intent.player_id, "mate_id": intent.mate_id},
            ),
            _advance_turn(state),
        ],
    )


def _handle_choose_target(state: GameState, intent: ChooseTargetIntent) -> EngineResult:
    _require_pending(state, intent.player_id, "duel")
    if intent.target_id == intent.player_id:
        raise EngineError("You can't duel yourself")
    if state.player_by_id(intent.target_id) is None:
        raise EngineError("Player is not in this room")
    state.pending_input = None
    state.battle = Battle(
        challenger_id=intent.player_id,
        opponent_id=intent.target_id,
        challenge=state.challenge_type,
        kind="duel",
    )
    return EngineResult(state=state, events=[_input_required_event(state)])


def _handle_break_mate(state: GameState, intent: BreakMateIntent) -> EngineResult:
    _require_pending(state, intent.player_id, "treason")
    remaining = [pair for pair in state.mates if set(pair) != {intent.a, intent.b}]
    if len(remaining) == len(state.mates):
        raise EngineError("Those two are not mates")
    state.mates = remaining
    state.pending_input = None
    return EngineResult(
        state=state,
        events=[
            ServerEvent(
                type="mate_broken",
                payload={"player_id": intent.player_id, "a": intent.a, "b": intent.b},
            ),
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
    if battle.kind == "rps" and intent.loser_id is None:
        raise EngineError("Rock-paper-scissors always has a loser")
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
    state.deck = new_deck(state.game_mode)
    state.direction = 1
    state.drawn_pile = []
    state.kings_drawn = 0
    state.current_turn_seat = _lowest_seat(state)
    state.rules = []
    state.banned_words = []
    state.mates = []
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


def _handle_return_to_lobby(state: GameState, intent: ReturnToLobbyIntent) -> EngineResult:
    _require_host(state, intent.player_id)
    if state.phase != GamePhase.FINISHED:
        raise EngineError("Game is not finished")
    state.deck = []
    state.direction = 1
    state.drawn_pile = []
    state.kings_drawn = 0
    state.rules = []
    state.banned_words = []
    state.mates = []
    state.pending_input = None
    state.battle = None
    state.phase = GamePhase.LOBBY
    return EngineResult(
        state=state,
        events=[ServerEvent(type="returned_to_lobby", payload=state.to_client_view())],
    )
