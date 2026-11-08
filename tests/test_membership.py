"""Engine tests: joining mid-game, leaving, kicking, host handoff, challenge setting."""
from __future__ import annotations

import pytest

from game_engine.engine import EngineError, apply_intent
from game_engine.models import (
    Card,
    DrawCardIntent,
    GamePhase,
    GameState,
    JoinIntent,
    KickPlayerIntent,
    LeaveRoomIntent,
    MakeHostIntent,
    PendingInput,
    Battle,
    Player,
    Rank,
    SetChallengeTypeIntent,
    Suit,
)


def _game(n=3, *, phase=GamePhase.IN_PROGRESS, turn=0, top=Rank.TWO, **kw) -> GameState:
    deck = [Card(rank=Rank.TWO, suit=Suit.CLUBS) for _ in range(10)] + [Card(rank=top, suit=Suit.HEARTS)]
    return GameState(
        room_id="r",
        phase=phase,
        players=[Player(id=f"p{i}", name=f"P{i}", seat=i) for i in range(n)],
        deck=deck,
        current_turn_seat=turn,
        host_id="p0",
        **kw,
    )


def _seats(s):
    return [p.seat for p in s.players]


# ---- joining ----

def test_first_joiner_becomes_host_and_seat_is_max_plus_one():
    s = GameState(room_id="r")
    apply_intent(s, JoinIntent(player_name="A"))
    apply_intent(s, JoinIntent(player_name="B"))
    assert s.host_id == s.players[0].id
    assert _seats(s) == [0, 1]


def test_join_after_removal_never_collides_with_an_existing_seat():
    s = _game(3)
    apply_intent(s, LeaveRoomIntent(player_id="p1"))  # seats 0, 2 remain
    apply_intent(s, JoinIntent(player_name="New"))
    assert sorted(_seats(s)) == [0, 2, 3]


def test_join_allowed_when_finished():
    s = _game(2, phase=GamePhase.FINISHED)
    apply_intent(s, JoinIntent(player_name="Late"))
    assert len(s.players) == 3


def test_mid_game_joiner_is_added_to_the_end_of_the_turn_order():
    s = _game(2, turn=1)
    apply_intent(s, JoinIntent(player_name="Late"))
    apply_intent(s, DrawCardIntent(player_id="p1"))
    assert s.current_turn_seat == 2  # the newcomer is up after p1


# ---- leaving / kicking ----

def test_leave_of_current_turn_player_moves_turn_to_next_seat():
    s = _game(3, turn=1)
    r = apply_intent(s, LeaveRoomIntent(player_id="p1"))
    assert [p.id for p in s.players] == ["p0", "p2"]
    assert s.current_turn_seat == 2
    assert r.events[0].type == "player_removed"
    assert r.events[0].payload["player_id"] == "p1"
    assert r.events[0].payload["reason"] == "left"


def test_turn_wraps_past_a_seat_gap():
    s = _game(3, turn=2)
    apply_intent(s, LeaveRoomIntent(player_id="p1"))  # seats 0, 2
    apply_intent(s, DrawCardIntent(player_id="p2"))
    assert s.current_turn_seat == 0
    apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.current_turn_seat == 2  # skips the vacated seat 1


def test_leave_of_someone_not_on_turn_keeps_the_turn():
    s = _game(3, turn=0)
    apply_intent(s, LeaveRoomIntent(player_id="p2"))
    assert s.current_turn_seat == 0


def test_removing_pending_input_owner_clears_it_and_advances():
    s = _game(3, turn=1)
    s.pending_input = PendingInput(player_id="p1", kind="word_ban")
    apply_intent(s, KickPlayerIntent(player_id="p0", target_id="p1"))
    assert s.pending_input is None
    assert s.current_turn_seat == 2
    apply_intent(s, DrawCardIntent(player_id="p2"))  # not stuck


def test_battle_challenger_leaving_cancels_battle_and_advances():
    s = _game(3, turn=1)
    s.battle = Battle(challenger_id="p1", opponent_id="p2", challenge="flip_cup")
    apply_intent(s, LeaveRoomIntent(player_id="p1"))
    assert s.battle is None
    assert s.current_turn_seat == 2


def test_battle_opponent_leaving_cancels_battle_and_ends_drawers_turn():
    s = _game(3, turn=1)
    s.battle = Battle(challenger_id="p1", opponent_id="p0", challenge="flip_cup")
    s.host_id = "p2"
    apply_intent(s, LeaveRoomIntent(player_id="p0"))
    assert s.battle is None
    assert s.current_turn_seat == 2  # drawer p1's turn is over
    assert s.host_id == "p2"


def test_game_finishes_when_fewer_than_two_players_remain():
    s = _game(2, turn=0)
    r = apply_intent(s, LeaveRoomIntent(player_id="p1"))
    assert s.phase == GamePhase.FINISHED
    assert [e.type for e in r.events] == ["player_removed", "game_finished"]


def test_leaving_in_lobby_just_removes_the_player():
    s = _game(3, phase=GamePhase.LOBBY)
    apply_intent(s, LeaveRoomIntent(player_id="p2"))
    assert len(s.players) == 2
    assert s.phase == GamePhase.LOBBY


def test_last_player_leaving_does_not_crash():
    s = _game(1, phase=GamePhase.LOBBY)
    apply_intent(s, LeaveRoomIntent(player_id="p0"))
    assert s.players == [] and s.host_id is None


def test_leave_by_a_non_member_is_rejected():
    s = _game(2)
    with pytest.raises(EngineError):
        apply_intent(s, LeaveRoomIntent(player_id="ghost"))


def test_only_host_can_kick_and_not_themselves():
    s = _game(3)
    with pytest.raises(EngineError, match="Only the host"):
        apply_intent(s, KickPlayerIntent(player_id="p1", target_id="p2"))
    with pytest.raises(EngineError, match="yourself"):
        apply_intent(s, KickPlayerIntent(player_id="p0", target_id="p0"))
    with pytest.raises(EngineError, match="not in this room"):
        apply_intent(s, KickPlayerIntent(player_id="p0", target_id="ghost"))


def test_kicked_player_cannot_resume_but_can_join_fresh():
    s = _game(3)
    apply_intent(s, KickPlayerIntent(player_id="p0", target_id="p2"))
    assert "p2" in s.kicked_ids
    with pytest.raises(EngineError, match="removed"):
        apply_intent(s, JoinIntent(player_name="P2", resume_token="p2"))
    apply_intent(s, JoinIntent(player_name="P2 again"))
    assert len(s.players) == 3


def test_leaver_resume_token_joins_as_a_new_player_not_the_old_seat():
    s = _game(3)
    apply_intent(s, LeaveRoomIntent(player_id="p2"))
    apply_intent(s, JoinIntent(player_name="P2", resume_token="p2"))
    assert s.players[-1].id != "p2"


def test_host_leaving_promotes_lowest_remaining_seat():
    s = _game(3)
    r = apply_intent(s, LeaveRoomIntent(player_id="p0"))
    assert s.host_id == "p1"
    assert r.events[0].payload["host_id"] == "p1"


def test_kicking_the_non_host_leaves_host_alone():
    s = _game(3)
    apply_intent(s, KickPlayerIntent(player_id="p0", target_id="p1"))
    assert s.host_id == "p0"


# ---- make host ----

def test_make_host_transfers_and_old_host_loses_powers():
    s = _game(3)
    r = apply_intent(s, MakeHostIntent(player_id="p0", target_id="p2"))
    assert s.host_id == "p2"
    assert r.events[0].type == "host_changed" and r.events[0].payload["host_id"] == "p2"
    with pytest.raises(EngineError, match="Only the host"):
        apply_intent(s, KickPlayerIntent(player_id="p0", target_id="p1"))
    apply_intent(s, KickPlayerIntent(player_id="p2", target_id="p1"))


def test_make_host_permissions_and_targets():
    s = _game(3)
    with pytest.raises(EngineError, match="Only the host"):
        apply_intent(s, MakeHostIntent(player_id="p1", target_id="p1"))
    with pytest.raises(EngineError, match="already the host"):
        apply_intent(s, MakeHostIntent(player_id="p0", target_id="p0"))
    with pytest.raises(EngineError, match="not in this room"):
        apply_intent(s, MakeHostIntent(player_id="p0", target_id="ghost"))


def test_host_follows_host_id_not_lowest_seat():
    s = _game(3)
    apply_intent(s, MakeHostIntent(player_id="p0", target_id="p2"))
    assert s.host().id == "p2"
    assert s.to_client_view()["host_id"] == "p2"


# ---- challenge type ----

def test_challenge_type_setting_is_host_only_lobby_only_and_used_by_battles():
    s = _game(3, phase=GamePhase.LOBBY)
    with pytest.raises(EngineError, match="Only the host"):
        apply_intent(s, SetChallengeTypeIntent(player_id="p1", challenge_type="bottle_flip"))
    r = apply_intent(s, SetChallengeTypeIntent(player_id="p0", challenge_type="bottle_flip"))
    assert r.events[0].payload == {"quick_flip_enabled": True, "challenge_type": "bottle_flip"}
    assert s.to_client_view()["challenge_type"] == "bottle_flip"

    s.phase = GamePhase.IN_PROGRESS
    with pytest.raises(EngineError, match="lobby"):
        apply_intent(s, SetChallengeTypeIntent(player_id="p0", challenge_type="flip_cup"))

    # every battle uses the table's single choice
    seen = set()
    for _ in range(40):
        g = _game(3, top=Rank.QUEEN, challenge_type="bottle_flip")
        apply_intent(g, DrawCardIntent(player_id="p0"))
        seen.add(g.battle.challenge)
    assert seen == {"bottle_flip"}


def test_restart_starts_from_lowest_remaining_seat():
    from game_engine.models import RestartGameIntent
    s = _game(3, turn=2)
    apply_intent(s, LeaveRoomIntent(player_id="p0"))  # host -> p1
    apply_intent(s, RestartGameIntent(player_id="p1"))
    assert s.current_turn_seat == 1
