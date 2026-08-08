"""Unit tests for game_engine.engine — pure functions, no I/O."""
from __future__ import annotations

import asyncio
from uuid import uuid4

import pytest

from game_engine.engine import EngineError, apply_intent
from game_engine.models import (
    Card,
    DrawCardIntent,
    GamePhase,
    GameState,
    JoinIntent,
    Player,
    Rank,
    StartGameIntent,
    Suit,
)
from game_engine.room_store import apply_with_lock, load_state


def _started_game(*, player_count: int = 3, kings_drawn: int = 0) -> GameState:
    players = [
        Player(id=f"p{i}", name=f"Player{i}", seat=i)
        for i in range(player_count)
    ]
    deck = [Card(rank=Rank.TWO, suit=Suit.CLUBS) for _ in range(52)]
    return GameState(
        room_id="room-1",
        phase=GamePhase.IN_PROGRESS,
        players=players,
        deck=deck,
        current_turn_seat=1,
        kings_drawn=kings_drawn,
    )


def test_turn_order_enforcement_rejects_out_of_turn_draw():
    state = _started_game(player_count=3)
    intent = DrawCardIntent(action_id="draw-1", player_id="p0")

    with pytest.raises(EngineError, match="It is not your turn"):
        apply_intent(state, intent)


def test_idempotent_action_id_is_noop_on_replay():
    state = _started_game(player_count=2)
    state.current_turn_seat = 0
    state.processed_action_ids.add("abc123")
    deck_before = len(state.deck)

    intent = DrawCardIntent(action_id="abc123", player_id="p0")
    result = apply_intent(state, intent)

    assert result.events == []
    assert len(state.deck) == deck_before
    assert "abc123" in state.processed_action_ids


def test_reconnect_via_resume_token_rejoins_same_seat():
    state = GameState(
        room_id="room-1",
        phase=GamePhase.IN_PROGRESS,
        players=[
            Player(id="p0", name="A", seat=0),
            Player(id="p1", name="B", seat=1),
            Player(id="player-1", name="Alice", seat=2, connected=False),
            Player(id="p3", name="D", seat=3),
        ],
    )
    intent = JoinIntent(
        action_id="join-reconnect",
        player_name="Alice-reconnect",
        resume_token="player-1",
    )

    result = apply_intent(state, intent)

    assert len(state.players) == 4
    assert state.players[2].id == "player-1"
    assert state.players[2].connected is True
    assert len(result.events) == 1
    assert result.events[0].type == "player_reconnected"
    assert result.events[0].type != "player_joined"


def test_king_count_four_ends_game():
    deck = [Card(rank=Rank.KING, suit=Suit.SPADES)]
    state = GameState(
        room_id="room-1",
        phase=GamePhase.IN_PROGRESS,
        players=[
            Player(id="p0", name="A", seat=0),
            Player(id="p1", name="B", seat=1),
        ],
        deck=deck,
        current_turn_seat=0,
        kings_drawn=3,
    )
    intent = DrawCardIntent(action_id="draw-king-4", player_id="p0")

    result = apply_intent(state, intent)

    assert state.phase == GamePhase.FINISHED
    assert state.kings_drawn == 4
    event_types = [e.type for e in result.events]
    assert "card_drawn" in event_types
    assert "game_finished" in event_types
    assert "turn_advanced" not in event_types


def test_resume_token_unknown_falls_through_to_join_if_lobby():
    state = GameState(room_id="room-1", phase=GamePhase.LOBBY)
    intent = JoinIntent(
        action_id="join-new",
        player_name="Newbie",
        resume_token="unknown-player-xyz",
    )

    result = apply_intent(state, intent)

    assert len(state.players) == 1
    assert result.events[0].type == "player_joined"


def test_resume_token_unknown_rejects_if_in_progress():
    state = _started_game(player_count=2)
    intent = JoinIntent(
        action_id="join-bad",
        player_name="Intruder",
        resume_token="unknown-player-xyz",
    )

    with pytest.raises(EngineError, match="Cannot join — game already in progress"):
        apply_intent(state, intent)


def test_empty_deck_rejects_draw():
    state = GameState(
        room_id="room-1",
        phase=GamePhase.IN_PROGRESS,
        players=[
            Player(id="p0", name="A", seat=0),
            Player(id="p1", name="B", seat=1),
        ],
        deck=[],
        current_turn_seat=0,
    )
    intent = DrawCardIntent(action_id="draw-empty", player_id="p0")

    with pytest.raises(EngineError, match="Deck is empty"):
        apply_intent(state, intent)


@pytest.mark.asyncio
async def test_concurrent_draws_same_room_no_lost_update(patch_redis):
    room_id = f"concurrent-{uuid4()}"
    deck = [Card(rank=Rank.TWO, suit=Suit.CLUBS) for _ in range(10)]

    async def setup():
        def _start(state: GameState):
            state.players = [
                Player(id="p0", name="A", seat=0),
                Player(id="p1", name="B", seat=1),
            ]
            state.phase = GamePhase.IN_PROGRESS
            state.deck = list(deck)
            state.current_turn_seat = 0
            from game_engine.engine import EngineResult

            return EngineResult(state=state, events=[])

        await apply_with_lock(room_id, _start)

    await setup()

    async def attempt_draw(action_id: str):
        intent = DrawCardIntent(action_id=action_id, player_id="p0")
        try:
            result = await apply_with_lock(room_id, lambda s: apply_intent(s, intent))
            return ("success", result)
        except EngineError as exc:
            return ("rejected", str(exc))

    results = await asyncio.gather(*[attempt_draw(f"draw-{i}") for i in range(10)])

    successes = [r for r in results if r[0] == "success"]
    rejections = [r for r in results if r[0] == "rejected"]

    assert len(successes) == 1
    assert len(rejections) == 9
    assert all("It is not your turn" in r[1] for r in rejections)

    _, success_result = successes[0]
    card_events = [e for e in success_result.events if e.type == "card_drawn"]
    assert len(card_events) == 1

    final = await load_state(room_id)
    assert len(final.deck) == 9
    assert len(final.drawn_pile) == 1
