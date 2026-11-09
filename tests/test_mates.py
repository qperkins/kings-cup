"""Drinking mates (rank 8): pick a mate, many pairs allowed, cleanup on leave/restart."""
from __future__ import annotations

import pytest

from game_engine.engine import EngineError, apply_intent
from game_engine.models import (
    Card,
    ChooseMateIntent,
    DrawCardIntent,
    GamePhase,
    GameState,
    LeaveRoomIntent,
    Player,
    Rank,
    RestartGameIntent,
    Suit,
)


def _game(players: int = 3, top: Rank = Rank.EIGHT) -> GameState:
    deck = [Card(rank=Rank.TWO, suit=Suit.CLUBS) for _ in range(10)] + [Card(rank=top, suit=Suit.HEARTS)]
    return GameState(
        room_id="r",
        phase=GamePhase.IN_PROGRESS,
        players=[Player(id=f"p{i}", name=f"P{i}", seat=i) for i in range(players)],
        deck=deck,
        current_turn_seat=0,
        host_id="p0",
    )


def test_eight_requires_a_mate_pick_and_blocks_draw():
    s = _game()
    apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.pending_input and s.pending_input.kind == "mate"
    assert s.pending_input.player_id == "p0"
    assert s.current_turn_seat == 0
    with pytest.raises(EngineError):
        apply_intent(s, DrawCardIntent(player_id="p0"))


def test_choose_mate_records_pair_and_advances_turn():
    s = _game()
    apply_intent(s, DrawCardIntent(player_id="p0"))
    res = apply_intent(s, ChooseMateIntent(player_id="p0", mate_id="p2"))
    assert s.mates == [["p0", "p2"]]
    assert s.pending_input is None
    assert s.current_turn_seat == 1
    assert [e.type for e in res.events] == ["mate_chosen", "turn_advanced"]
    assert s.to_client_view()["mates"] == [["p0", "p2"]]


def test_choose_mate_rejects_self_unknown_wrong_player_and_duplicates():
    s = _game()
    apply_intent(s, DrawCardIntent(player_id="p0"))
    with pytest.raises(EngineError):
        apply_intent(s, ChooseMateIntent(player_id="p0", mate_id="p0"))
    with pytest.raises(EngineError):
        apply_intent(s, ChooseMateIntent(player_id="p0", mate_id="ghost"))
    with pytest.raises(EngineError):
        apply_intent(s, ChooseMateIntent(player_id="p1", mate_id="p2"))
    apply_intent(s, ChooseMateIntent(player_id="p0", mate_id="p1"))
    # Nothing pending any more.
    with pytest.raises(EngineError):
        apply_intent(s, ChooseMateIntent(player_id="p0", mate_id="p2"))


def test_duplicate_pair_rejected_in_either_direction():
    s = _game()
    s.mates = [["p1", "p0"]]
    apply_intent(s, DrawCardIntent(player_id="p0"))
    with pytest.raises(EngineError):
        apply_intent(s, ChooseMateIntent(player_id="p0", mate_id="p1"))
    apply_intent(s, ChooseMateIntent(player_id="p0", mate_id="p2"))
    assert len(s.mates) == 2  # a player may be in several pairs


def test_eight_is_skipped_when_drawer_is_already_mates_with_everyone():
    s = _game(players=2)
    s.mates = [["p0", "p1"]]
    res = apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.pending_input is None
    assert s.current_turn_seat == 1
    assert [e.type for e in res.events] == ["card_drawn", "turn_advanced"]


def test_leaving_drops_that_players_mates():
    s = _game()
    s.mates = [["p0", "p1"], ["p1", "p2"], ["p0", "p2"]]
    apply_intent(s, LeaveRoomIntent(player_id="p1"))
    assert s.mates == [["p0", "p2"]]


def test_drawer_leaving_mid_pick_moves_turn_on():
    s = _game()
    apply_intent(s, DrawCardIntent(player_id="p0"))
    apply_intent(s, LeaveRoomIntent(player_id="p0"))
    assert s.pending_input is None
    assert s.current_turn_seat == 1


def test_only_candidate_leaving_cancels_pick():
    s = _game(players=3)
    s.mates = [["p0", "p1"]]  # only p2 is left to pick
    apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.pending_input is not None
    apply_intent(s, LeaveRoomIntent(player_id="p2"))
    assert s.pending_input is None
    assert s.phase == GamePhase.IN_PROGRESS or s.phase == GamePhase.FINISHED


def test_restart_clears_mates():
    s = _game()
    s.mates = [["p0", "p1"]]
    apply_intent(s, RestartGameIntent(player_id="p0"))
    assert s.mates == []
