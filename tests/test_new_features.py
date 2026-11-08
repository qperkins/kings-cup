"""Engine tests: Quick Flip Battle, Queen's Rule, Jack's Trap, host controls."""
from __future__ import annotations

import pytest

from game_engine.engine import EngineError, apply_intent
from game_engine.models import (
    Card,
    DrawCardIntent,
    EndGameIntent,
    GamePhase,
    GameState,
    Player,
    Rank,
    RestartGameIntent,
    ResolveBattleIntent,
    SetQuickFlipIntent,
    SubmitBanIntent,
    SubmitRuleIntent,
    Suit,
)


def _game(top: Rank, *, players: int = 3, quick_flip: bool = True, phase=GamePhase.IN_PROGRESS) -> GameState:
    deck = [Card(rank=Rank.TWO, suit=Suit.CLUBS) for _ in range(10)] + [Card(rank=top, suit=Suit.HEARTS)]
    return GameState(
        room_id="r",
        phase=phase,
        players=[Player(id=f"p{i}", name=f"P{i}", seat=i) for i in range(players)],
        deck=deck,
        current_turn_seat=0,
        quick_flip_enabled=quick_flip,
    )


def test_queen_with_quick_flip_creates_battle_and_blocks_draw():
    s = _game(Rank.QUEEN)
    apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.battle and s.battle.challenger_id == "p0"
    assert s.battle.opponent_id in {"p1", "p2"}
    assert s.battle.challenge == "flip_cup"  # the table default, not random
    assert s.current_turn_seat == 0  # turn not advanced yet
    with pytest.raises(EngineError):
        apply_intent(s, DrawCardIntent(player_id="p0"))


def test_resolve_battle_only_by_challenger_and_advances_turn():
    s = _game(Rank.QUEEN)
    apply_intent(s, DrawCardIntent(player_id="p0"))
    with pytest.raises(EngineError):
        apply_intent(s, ResolveBattleIntent(player_id="p1", loser_id="p0"))
    with pytest.raises(EngineError):
        apply_intent(s, ResolveBattleIntent(player_id="p0", loser_id="nobody"))
    apply_intent(s, ResolveBattleIntent(player_id="p0", loser_id=None))
    assert s.battle is None and s.current_turn_seat == 1


def test_queen_toggle_off_or_solo_prompts_for_rule():
    for s in (_game(Rank.QUEEN, quick_flip=False), _game(Rank.QUEEN, players=1)):
        apply_intent(s, DrawCardIntent(player_id="p0"))
        assert s.battle is None
        assert s.pending_input and s.pending_input.kind == "rule"


def test_submit_rule_only_by_pending_player():
    s = _game(Rank.QUEEN, quick_flip=False)
    apply_intent(s, DrawCardIntent(player_id="p0"))
    with pytest.raises(EngineError):
        apply_intent(s, SubmitRuleIntent(player_id="p1", text="no pointing"))
    with pytest.raises(EngineError):
        apply_intent(s, SubmitRuleIntent(player_id="p0", text="   "))
    apply_intent(s, SubmitRuleIntent(player_id="p0", text="no pointing"))
    assert s.rules == ["no pointing"] and s.pending_input is None and s.current_turn_seat == 1


def test_jack_ban_word_dedupes_case_insensitively():
    s = _game(Rank.JACK)
    apply_intent(s, DrawCardIntent(player_id="p0"))
    assert s.pending_input.kind == "word_ban"
    apply_intent(s, SubmitBanIntent(player_id="p0", word="Banana"))
    assert s.banned_words == ["Banana"] and s.current_turn_seat == 1
    s.deck.append(Card(rank=Rank.JACK, suit=Suit.SPADES))
    apply_intent(s, DrawCardIntent(player_id="p1"))
    with pytest.raises(EngineError):
        apply_intent(s, SubmitBanIntent(player_id="p1", word="banana"))


def test_quick_flip_toggle_host_and_lobby_only():
    s = _game(Rank.TWO, phase=GamePhase.LOBBY)
    with pytest.raises(EngineError):
        apply_intent(s, SetQuickFlipIntent(player_id="p1", enabled=False))
    apply_intent(s, SetQuickFlipIntent(player_id="p0", enabled=False))
    assert s.quick_flip_enabled is False
    s.phase = GamePhase.IN_PROGRESS
    with pytest.raises(EngineError):
        apply_intent(s, SetQuickFlipIntent(player_id="p0", enabled=True))


def test_restart_and_end_are_host_only_and_restart_resets():
    s = _game(Rank.JACK)
    apply_intent(s, DrawCardIntent(player_id="p0"))
    apply_intent(s, SubmitBanIntent(player_id="p0", word="x"))
    for intent in (RestartGameIntent(player_id="p1"), EndGameIntent(player_id="p1")):
        with pytest.raises(EngineError):
            apply_intent(s, intent)
    apply_intent(s, RestartGameIntent(player_id="p0"))
    assert s.banned_words == [] and s.rules == [] and s.drawn_pile == []
    assert s.kings_drawn == 0 and len(s.deck) == 52 and s.phase == GamePhase.IN_PROGRESS
    apply_intent(s, EndGameIntent(player_id="p0"))
    assert s.phase == GamePhase.FINISHED


def test_client_view_includes_new_fields():
    s = _game(Rank.JACK)
    apply_intent(s, DrawCardIntent(player_id="p0"))
    v = s.to_client_view()
    assert v["pending_input"]["kind"] == "word_ban"
    assert v["rules"] == [] and v["banned_words"] == [] and v["quick_flip_enabled"] is True
    assert v["drawn_pile_top"]["rule_text"] == "Jack's Trap"
