"""Royal Mayhem: game mode, 64-card deck, 6-King end, and the Court of Chaos wildcards."""
from __future__ import annotations

import pytest

from game_engine.engine import EngineError, apply_intent
from game_engine.models import (
    BreakMateIntent,
    Card,
    ChooseTargetIntent,
    DrawCardIntent,
    GamePhase,
    GameState,
    LeaveRoomIntent,
    Player,
    Rank,
    ResolveBattleIntent,
    SetGameModeIntent,
    StartGameIntent,
    Suit,
    WILD_RULES,
    new_deck,
)


def _wild(wid: str) -> Card:
    return Card(kind="wild", wild_id=wid)


def _game(top: Card, *, players: int = 4, mode: str = "royal_mayhem") -> GameState:
    deck = [Card(rank=Rank.TWO, suit=Suit.CLUBS) for _ in range(10)] + [top]
    return GameState(
        room_id="r",
        phase=GamePhase.IN_PROGRESS,
        players=[Player(id=f"p{i}", name=f"P{i}", seat=i) for i in range(players)],
        deck=deck,
        current_turn_seat=0,
        host_id="p0",
        game_mode=mode,
    )


def test_deck_sizes():
    assert len(new_deck()) == 52
    royal = new_deck("royal_mayhem")
    assert len(royal) == 64
    assert sum(1 for c in royal if c.is_wild) == 12
    assert sorted(c.wild_id for c in royal if c.is_wild) == sorted(WILD_RULES)
    assert sum(1 for c in royal if c.is_king) == 6  # 4 real Kings + 2 Kings of Chaos


def test_game_mode_host_and_lobby_only_and_applied_on_start():
    s = GameState(
        room_id="r",
        players=[Player(id=f"p{i}", name=f"P{i}", seat=i) for i in range(2)],
        host_id="p0",
    )
    with pytest.raises(EngineError):
        apply_intent(s, SetGameModeIntent(player_id="p1", mode="royal_mayhem"))
    res = apply_intent(s, SetGameModeIntent(player_id="p0", mode="royal_mayhem"))
    assert res.events[0].payload["game_mode"] == "royal_mayhem"
    apply_intent(s, StartGameIntent())
    assert len(s.deck) == 64
    with pytest.raises(EngineError):
        apply_intent(s, SetGameModeIntent(player_id="p0", mode="classic"))


def test_game_ends_on_sixth_king_in_royal_mayhem_but_fourth_in_classic():
    s = _game(Card(rank=Rank.KING, suit=Suit.HEARTS))
    s.kings_drawn = 4
    apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.phase == GamePhase.IN_PROGRESS  # 5th King: keep going
    s.current_turn_seat = 0
    s.deck.append(_wild("king_chaos_a"))
    apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.kings_drawn == 6 and s.phase == GamePhase.FINISHED

    c = _game(Card(rank=Rank.KING, suit=Suit.SPADES), mode="classic")
    c.kings_drawn = 3
    apply_intent(c, DrawCardIntent(player_id="p0"))
    assert c.phase == GamePhase.FINISHED


def test_reverse_decree_flips_direction_and_next_turn_goes_backwards():
    s = _game(_wild("reverse"))
    s.current_turn_seat = 1
    res = apply_intent(s, DrawCardIntent(player_id="p1"))
    assert s.direction == -1
    assert s.current_turn_seat == 0
    assert [e.type for e in res.events] == ["card_drawn", "direction_changed", "turn_advanced"]
    # Wraps below the lowest seat to the highest.
    s.deck.append(Card(rank=Rank.TWO, suit=Suit.CLUBS))
    apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.current_turn_seat == 3


def test_exile_skips_next_player_and_names_them():
    s = _game(_wild("exile"))
    res = apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.current_turn_seat == 2
    drawn = res.events[0].payload
    assert "P1" in drawn["rule_text"] and "1 shot (or 3 drinks)" in drawn["rule_text"]
    assert res.events[1].type == "player_exiled" and res.events[1].payload["player_id"] == "p1"


def test_exile_with_two_players_returns_to_drawer():
    s = _game(_wild("exile"), players=2)
    apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.current_turn_seat == 0


def test_royal_encore_keeps_the_turn():
    s = _game(_wild("encore"))
    apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.current_turn_seat == 0 and s.pending_input is None
    apply_intent(s, DrawCardIntent(player_id="p0"))  # allowed again


@pytest.mark.parametrize("wid", ["jester", "plague", "pardon", "silence", "king_chaos_b"])
def test_table_resolved_wildcards_just_advance(wid):
    s = _game(_wild(wid))
    apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.current_turn_seat == 1 and s.pending_input is None and s.battle is None


def test_scepter_showdown_is_an_rps_battle_with_no_tie():
    s = _game(_wild("scepter"))
    apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.battle and s.battle.kind == "rps" and s.battle.challenger_id == "p0"
    assert s.battle.opponent_id in {"p1", "p2", "p3"}
    with pytest.raises(EngineError):
        apply_intent(s, DrawCardIntent(player_id="p0"))  # blocked until resolved
    with pytest.raises(EngineError):
        apply_intent(s, ResolveBattleIntent(player_id="p1", loser_id="p0"))  # challenger only
    with pytest.raises(EngineError):
        apply_intent(s, ResolveBattleIntent(player_id="p0", loser_id=None))  # no ties
    apply_intent(s, ResolveBattleIntent(player_id="p0", loser_id=s.battle.opponent_id))
    assert s.battle is None and s.current_turn_seat == 1


def test_scepter_showdown_cancelled_if_opponent_leaves():
    s = _game(_wild("scepter"))
    apply_intent(s, DrawCardIntent(player_id="p0"))
    opponent = s.battle.opponent_id
    apply_intent(s, LeaveRoomIntent(player_id=opponent))
    assert s.battle is None


def test_royal_duel_drawer_picks_opponent():
    s = _game(_wild("duel"))
    apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.pending_input and s.pending_input.kind == "duel"
    with pytest.raises(EngineError):
        apply_intent(s, ChooseTargetIntent(player_id="p0", target_id="p0"))
    with pytest.raises(EngineError):
        apply_intent(s, ChooseTargetIntent(player_id="p1", target_id="p2"))
    apply_intent(s, ChooseTargetIntent(player_id="p0", target_id="p3"))
    assert s.pending_input is None
    assert s.battle and s.battle.kind == "duel" and s.battle.opponent_id == "p3"
    apply_intent(s, ResolveBattleIntent(player_id="p0", loser_id=None))  # ties allowed for duels
    assert s.current_turn_seat == 1


def test_treason_breaks_a_chosen_pair():
    s = _game(_wild("treason"))
    s.mates = [["p1", "p2"], ["p2", "p3"]]
    apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.pending_input and s.pending_input.kind == "treason"
    with pytest.raises(EngineError):
        apply_intent(s, BreakMateIntent(player_id="p0", a="p0", b="p1"))
    res = apply_intent(s, BreakMateIntent(player_id="p0", a="p3", b="p2"))  # either order
    assert s.mates == [["p1", "p2"]]
    assert [e.type for e in res.events] == ["mate_broken", "turn_advanced"]
    assert s.current_turn_seat == 1


def test_treason_with_no_pairs_is_skipped():
    s = _game(_wild("treason"))
    res = apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.pending_input is None and s.current_turn_seat == 1
    assert res.events[-1].type == "turn_advanced"


def test_last_pair_vanishing_cancels_pending_treason():
    s = _game(_wild("treason"), players=4)
    s.mates = [["p1", "p2"]]
    apply_intent(s, DrawCardIntent(player_id="p0"))
    apply_intent(s, LeaveRoomIntent(player_id="p2"))
    assert s.mates == [] and s.pending_input is None
    assert s.current_turn_seat == 1


def test_wild_card_wire_shape():
    s = _game(_wild("jester"))
    res = apply_intent(s, DrawCardIntent(player_id="p0"))
    card = res.events[0].payload["card"]
    assert card["kind"] == "wild" and card["wild_id"] == "jester" and card["rank"] is None
    view = s.to_client_view()
    assert view["game_mode"] == "royal_mayhem" and view["direction"] == 1
    assert view["drawn_pile_top"]["wild_id"] == "jester"


def test_wildcard_punishment_wording_is_consistent():
    """Regression: Decree of Silence only said "drinks". Every wildcard that punishes someone
    must say "1 shot (or 3 drinks)" (Scepter Showdown is the one deliberate "3 drinks"),
    and no wildcard text may use "sip" or "drink 1 shot"."""
    from game_engine.models import WILD_DRINK, WILD_RULES

    assert WILD_DRINK == "1 shot (or 3 drinks)"
    for wid, text in WILD_RULES.items():
        low = text.lower()
        assert "sip" not in low and "drink 1 shot" not in low, (wid, text)
    for wid in ("jester", "exile", "plague", "silence", "duel", "treason"):
        assert WILD_DRINK in WILD_RULES[wid], (wid, WILD_RULES[wid])
    assert "3 drinks" in WILD_RULES["scepter"] and "shot" not in WILD_RULES["scepter"]
