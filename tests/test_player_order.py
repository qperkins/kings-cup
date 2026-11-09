"""Lobby player order: host-only drag reorder and shuffle."""
from __future__ import annotations

import pytest

from game_engine.engine import EngineError, apply_intent
from game_engine.models import (
    GamePhase,
    GameState,
    Player,
    ReorderPlayersIntent,
    ShufflePlayersIntent,
)


def _lobby(seats=(0, 1, 2)) -> GameState:
    return GameState(
        room_id="r",
        phase=GamePhase.LOBBY,
        players=[Player(id=f"p{s}", name=f"P{s}", seat=s) for s in seats],
        host_id="p0",
    )


def test_reorder_reassigns_compact_seats_and_emits_event():
    s = _lobby(seats=(0, 2, 5))  # gaps from earlier leaves
    res = apply_intent(s, ReorderPlayersIntent(player_id="p0", order=["p5", "p0", "p2"]))
    assert [(p.id, p.seat) for p in s.players] == [("p5", 0), ("p0", 1), ("p2", 2)]
    assert res.events[0].type == "players_reordered"
    assert [p["id"] for p in res.events[0].payload["players"]] == ["p5", "p0", "p2"]


@pytest.mark.parametrize(
    "order",
    [["p0", "p1"], ["p0", "p1", "p1"], ["p0", "p1", "ghost"], ["p0", "p1", "p2", "p2"]],
)
def test_reorder_requires_exact_player_set(order):
    s = _lobby()
    with pytest.raises(EngineError):
        apply_intent(s, ReorderPlayersIntent(player_id="p0", order=order))


def test_reorder_and_shuffle_are_host_only():
    s = _lobby()
    with pytest.raises(EngineError):
        apply_intent(s, ReorderPlayersIntent(player_id="p1", order=["p0", "p1", "p2"]))
    with pytest.raises(EngineError):
        apply_intent(s, ShufflePlayersIntent(player_id="p1"))


def test_reorder_and_shuffle_are_lobby_only():
    s = _lobby()
    s.phase = GamePhase.IN_PROGRESS
    with pytest.raises(EngineError):
        apply_intent(s, ReorderPlayersIntent(player_id="p0", order=["p2", "p1", "p0"]))
    with pytest.raises(EngineError):
        apply_intent(s, ShufflePlayersIntent(player_id="p0"))


def test_shuffle_keeps_everyone_with_compact_seats():
    s = _lobby(seats=(0, 3, 4, 9))
    res = apply_intent(s, ShufflePlayersIntent(player_id="p0"))
    assert sorted(p.id for p in s.players) == ["p0", "p3", "p4", "p9"]
    assert [p.seat for p in s.players] == [0, 1, 2, 3]
    assert res.events[0].type == "players_reordered"
