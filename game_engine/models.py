"""
Domain models for the King's Cup game engine.

These are pure data shapes — no FastAPI, no I/O, no network awareness.
That separation is deliberate: the rules engine should be testable and
reasoned about without spinning up a server.
"""
from __future__ import annotations

import random
from enum import Enum
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field


class Suit(str, Enum):
    HEARTS = "hearts"
    DIAMONDS = "diamonds"
    CLUBS = "clubs"
    SPADES = "spades"


class Rank(str, Enum):
    TWO = "2"
    THREE = "3"
    FOUR = "4"
    FIVE = "5"
    SIX = "6"
    SEVEN = "7"
    EIGHT = "8"
    NINE = "9"
    TEN = "10"
    JACK = "J"
    QUEEN = "Q"
    KING = "K"
    ACE = "A"


class Card(BaseModel):
    rank: Rank
    suit: Suit

    def rule_text(self, quick_flip: bool = False) -> str:
        # King's Cup rule mapping — extend/replace with your own house rules.
        # quick_flip selects the Queen variant (lobby setting).
        queen = "Quick Flip Battle" if quick_flip else "Queen's Rule"
        return {
            Rank.TWO: "Take a drink",
            Rank.THREE: "Give a drink",
            Rank.FOUR: "Floor — last to touch it drinks",
            Rank.FIVE: "Guys drink",
            Rank.SIX: "Ladies drink",
            Rank.SEVEN: "Point to heaven — last one drinks",
            Rank.EIGHT: "Mate — pick a drinking buddy",
            Rank.NINE: "Rhyme — say a word, go around rhyming",
            Rank.TEN: "Categories",
            Rank.JACK: "Jack's Trap",
            Rank.QUEEN: queen,
            Rank.KING: "Pour into the King's Cup",
            Rank.ACE: "Waterfall",
        }[self.rank]


class Player(BaseModel):
    id: str
    name: str
    seat: int
    connected: bool = True


class GamePhase(str, Enum):
    LOBBY = "lobby"
    IN_PROGRESS = "in_progress"
    FINISHED = "finished"


class PendingInput(BaseModel):
    """A player must type something (a rule or a banned word) before play continues."""
    player_id: str
    kind: Literal["rule", "word_ban"]


class Battle(BaseModel):
    """Quick Flip Battle: challenger (the Queen drawer) vs a random opponent.
    The challenge type comes from the table's lobby setting, never per battle."""
    challenger_id: str
    opponent_id: str
    challenge: Literal["flip_cup", "bottle_flip"]


class GameState(BaseModel):
    """The single source of truth for a room. Server-owned — clients never
    write to this directly, they only send intents (see ActionIntent)."""

    room_id: str
    phase: GamePhase = GamePhase.LOBBY
    players: list[Player] = Field(default_factory=list)
    deck: list[Card] = Field(default_factory=list)
    drawn_pile: list[Card] = Field(default_factory=list)
    current_turn_seat: int = 0
    kings_drawn: int = 0
    quick_flip_enabled: bool = True
    rules: list[str] = Field(default_factory=list)
    banned_words: list[str] = Field(default_factory=list)
    pending_input: PendingInput | None = None
    battle: Battle | None = None
    # Explicit host. None only before the first join; host() falls back to the lowest seat.
    host_id: str | None = None
    # Which Quick Flip challenge this table uses (set once by the host in the lobby).
    challenge_type: Literal["flip_cup", "bottle_flip"] = "flip_cup"
    # Players removed by the host; their ids can't resume a session.
    kicked_ids: set[str] = Field(default_factory=set)
    # every processed action id, so replayed/duplicate client messages are no-ops
    processed_action_ids: set[str] = Field(default_factory=set)

    def active_player(self) -> Player | None:
        for p in self.players:
            if p.seat == self.current_turn_seat:
                return p
        return None

    def player_by_id(self, player_id: str) -> Player | None:
        for p in self.players:
            if p.id == player_id:
                return p
        return None

    def host(self) -> Player | None:
        """The explicit host, falling back to the lowest seat (e.g. legacy state)."""
        if self.host_id:
            for p in self.players:
                if p.id == self.host_id:
                    return p
        return min(self.players, key=lambda p: p.seat) if self.players else None

    def to_client_view(self) -> dict:
        """Serialize game state for client consumption.
        
        Returns a dict containing the full game state visible to clients.
        The caller (main.py) will add 'your_player_id' to this dict before
        sending as a state_sync event - that field is documented here but
        populated per-call rather than stored on GameState itself.
        
        Return shape:
        {
            'room_id': str,
            'phase': 'lobby' | 'in_progress' | 'finished',
            'players': [{'id': str, 'name': str, 'seat': int, 'connected': bool}, ...],
            'current_turn_seat': int,
            'kings_drawn': int,
            'cards_remaining': int,
            'drawn_pile_top': {'rank': str, 'suit': str, 'rule_text': str} | None,
            'quick_flip_enabled': bool,
            'challenge_type': 'flip_cup' | 'bottle_flip',
            'host_id': str | None,
            'rules': [str, ...],
            'banned_words': [str, ...],
            'pending_input': {'player_id': str, 'kind': 'rule' | 'word_ban'} | None,
            'battle': {'challenger_id': str, 'opponent_id': str,
                       'challenge': 'flip_cup' | 'bottle_flip'} | None,
            
            # Added by caller in main.py, not by this method:
            'your_player_id': str  # which player in the roster is the receiving client
        }
        
        Note: drawn_pile_top includes rule_text to match card_drawn event's shape.
        Without it, reconnecting clients would need to reimplement rule_text()
        mapping in TypeScript, duplicating business logic across the client boundary.
        """
        return {
            "room_id": self.room_id,
            "phase": self.phase.value,
            "players": [p.model_dump() for p in self.players],
            "current_turn_seat": self.current_turn_seat,
            "kings_drawn": self.kings_drawn,
            "cards_remaining": len(self.deck),
            "drawn_pile_top": {
                **self.drawn_pile[-1].model_dump(),
                "rule_text": self.drawn_pile[-1].rule_text(self.quick_flip_enabled),
            } if self.drawn_pile else None,
            "quick_flip_enabled": self.quick_flip_enabled,
            "challenge_type": self.challenge_type,
            "host_id": self.host().id if self.host() else None,
            "rules": list(self.rules),
            "banned_words": list(self.banned_words),
            "pending_input": self.pending_input.model_dump() if self.pending_input else None,
            "battle": self.battle.model_dump() if self.battle else None,
        }


def new_deck() -> list[Card]:
    deck = [Card(rank=r, suit=s) for r in Rank for s in Suit]
    random.shuffle(deck)
    return deck


# ---- Wire protocol: what flows over the WebSocket ----

class JoinIntent(BaseModel):
    type: Literal["join"] = "join"
    action_id: str = Field(default_factory=lambda: str(uuid4()))
    player_name: str
    resume_token: str | None = None  # present when reconnecting


class DrawCardIntent(BaseModel):
    type: Literal["draw_card"] = "draw_card"
    action_id: str = Field(default_factory=lambda: str(uuid4()))
    player_id: str


class StartGameIntent(BaseModel):
    type: Literal["start_game"] = "start_game"
    action_id: str = Field(default_factory=lambda: str(uuid4()))


class SetQuickFlipIntent(BaseModel):
    type: Literal["set_quick_flip"] = "set_quick_flip"
    action_id: str = Field(default_factory=lambda: str(uuid4()))
    player_id: str
    enabled: bool


class SetChallengeTypeIntent(BaseModel):
    type: Literal["set_challenge_type"] = "set_challenge_type"
    action_id: str = Field(default_factory=lambda: str(uuid4()))
    player_id: str
    challenge_type: Literal["flip_cup", "bottle_flip"]


class LeaveRoomIntent(BaseModel):
    type: Literal["leave_room"] = "leave_room"
    action_id: str = Field(default_factory=lambda: str(uuid4()))
    player_id: str


class KickPlayerIntent(BaseModel):
    type: Literal["kick_player"] = "kick_player"
    action_id: str = Field(default_factory=lambda: str(uuid4()))
    player_id: str
    target_id: str


class MakeHostIntent(BaseModel):
    type: Literal["make_host"] = "make_host"
    action_id: str = Field(default_factory=lambda: str(uuid4()))
    player_id: str
    target_id: str


class SubmitRuleIntent(BaseModel):
    type: Literal["submit_rule"] = "submit_rule"
    action_id: str = Field(default_factory=lambda: str(uuid4()))
    player_id: str
    text: str


class SubmitBanIntent(BaseModel):
    type: Literal["submit_ban"] = "submit_ban"
    action_id: str = Field(default_factory=lambda: str(uuid4()))
    player_id: str
    word: str


class ResolveBattleIntent(BaseModel):
    type: Literal["resolve_battle"] = "resolve_battle"
    action_id: str = Field(default_factory=lambda: str(uuid4()))
    player_id: str
    loser_id: str | None = None  # None = tie / no drink


class RestartGameIntent(BaseModel):
    type: Literal["restart_game"] = "restart_game"
    action_id: str = Field(default_factory=lambda: str(uuid4()))
    player_id: str


class EndGameIntent(BaseModel):
    type: Literal["end_game"] = "end_game"
    action_id: str = Field(default_factory=lambda: str(uuid4()))
    player_id: str


ActionIntent = (
    JoinIntent
    | DrawCardIntent
    | StartGameIntent
    | SetQuickFlipIntent
    | SetChallengeTypeIntent
    | LeaveRoomIntent
    | KickPlayerIntent
    | MakeHostIntent
    | SubmitRuleIntent
    | SubmitBanIntent
    | ResolveBattleIntent
    | RestartGameIntent
    | EndGameIntent
)


class ServerEvent(BaseModel):
    """What the server broadcasts after processing an intent."""
    type: str
    payload: dict
