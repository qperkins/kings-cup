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

    def rule_text(self) -> str:
        # King's Cup rule mapping — extend/replace with your own house rules
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
            Rank.JACK: "Never have I ever",
            Rank.QUEEN: "Question master",
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
    # every processed action id, so replayed/duplicate client messages are no-ops
    processed_action_ids: set[str] = Field(default_factory=set)

    def active_player(self) -> Player | None:
        for p in self.players:
            if p.seat == self.current_turn_seat:
                return p
        return None


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


ActionIntent = JoinIntent | DrawCardIntent | StartGameIntent


class ServerEvent(BaseModel):
    """What the server broadcasts after processing an intent."""
    type: str
    payload: dict
