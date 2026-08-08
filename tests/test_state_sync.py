"""Tests for targeted state_sync events after join/reconnect."""
from __future__ import annotations

import json
import time
from uuid import uuid4

import pytest
import websockets
from starlette.testclient import TestClient

from game_engine.engine import EngineResult
from game_engine.models import Card, GamePhase, Player, Rank, Suit
from game_engine.room_store import apply_with_lock
from tests.ws_helpers import join_and_sync, recv_all_pending, recv_until


@pytest.mark.asyncio
async def test_join_produces_state_sync_with_correct_your_player_id(ws_server):
    room_id = f"sync-join-{uuid4()}"
    async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_a:
        async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_b:
            async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_c:
                await join_and_sync(ws_a, "Alice")
                await join_and_sync(ws_b, "Bob")
                sync = await join_and_sync(ws_c, "Carol")

    assert sync[0]["type"] == "state_sync"
    carol_id = sync[0]["payload"]["your_player_id"]
    assert carol_id == sync[0]["payload"]["players"][-1]["id"]
    assert len(sync[0]["payload"]["players"]) == 3


@pytest.mark.asyncio
async def test_reconnect_produces_state_sync_for_resumed_player_only(ws_server):
    room_id = f"sync-reconnect-{uuid4()}"

    async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_a:
        sync_a = await join_and_sync(ws_a, "Alice")
        player_a_id = sync_a[1]
        async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_b:
            sync_b = await join_and_sync(ws_b, "Bob")
            player_b_id = sync_b[1]
            await ws_b.send(json.dumps({"type": "start_game", "action_id": str(uuid4())}))
            await recv_until(ws_b, lambda m: m.get("type") == "game_started")
            await recv_until(ws_a, lambda m: m.get("type") == "game_started")

    async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_b2:
        async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_a2:
            reconnect_sync = await join_and_sync(ws_b2, "Bob-back", resume_token=player_b_id)
            assert reconnect_sync[0]["payload"]["your_player_id"] == player_b_id
            b_extra = await recv_all_pending(ws_b2)
            assert not any(m.get("type") == "state_sync" for m in b_extra)

            await join_and_sync(ws_a2, "Alice-back", resume_token=player_a_id)
            b_after_a = await recv_all_pending(ws_b2, 0.5)
            assert any(m.get("type") == "player_reconnected" for m in b_after_a)
            assert not any(m.get("type") == "state_sync" for m in b_after_a)


@pytest.mark.asyncio
async def test_player_a_does_not_receive_player_b_state_sync(ws_server):
    room_id = f"sync-isolation-{uuid4()}"
    async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_a:
        async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_b:
            await join_and_sync(ws_a, "Alice")
            await join_and_sync(ws_b, "Bob")
            a_messages = await recv_all_pending(ws_a, 0.5)

    assert any(m.get("type") == "player_joined" for m in a_messages)
    assert not any(m.get("type") == "state_sync" for m in a_messages)


@pytest.mark.asyncio
async def test_drawn_pile_top_includes_rule_text_after_draw(
    test_client: TestClient, patch_redis, local_broadcast
):
    room_id = f"sync-pile-{uuid4()}"
    queen = Card(rank=Rank.QUEEN, suit=Suit.HEARTS)

    def seed_drawn_pile(state):
        state.players = [
            Player(id="p0", name="A", seat=0),
            Player(id="p1", name="B", seat=1),
        ]
        state.phase = GamePhase.IN_PROGRESS
        state.deck = []
        state.drawn_pile = [queen]
        state.current_turn_seat = 1
        return EngineResult(state=state, events=[])

    await apply_with_lock(room_id, seed_drawn_pile)

    with test_client.websocket_connect(f"/ws/{room_id}") as ws:
        ws.send_json(
            {
                "type": "join",
                "action_id": str(uuid4()),
                "player_name": "B-back",
                "resume_token": "p1",
            }
        )
        sync = None
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            msg = ws.receive_json()
            if msg.get("type") == "state_sync":
                sync = msg
                break
        assert sync is not None

    top = sync["payload"]["drawn_pile_top"]
    assert top is not None
    assert top["rank"] == "Q"
    assert top["suit"] == "hearts"
    assert top["rule_text"] == queen.rule_text()


@pytest.mark.asyncio
async def test_drawn_pile_top_null_before_first_draw(ws_server):
    room_id = f"sync-empty-pile-{uuid4()}"

    async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_a:
        sync_a = await join_and_sync(ws_a, "Alice")
        player_a_id = sync_a[1]
        async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_b:
            sync_b = await join_and_sync(ws_b, "Bob")
            player_b_id = sync_b[1]

    async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_a2:
        await join_and_sync(ws_a2, "Alice-back", resume_token=player_a_id)
        await ws_a2.send(json.dumps({"type": "start_game", "action_id": str(uuid4())}))
        await recv_until(ws_a2, lambda m: m.get("type") == "game_started")

    async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_b2:
        sync = await join_and_sync(ws_b2, "Bob-back", resume_token=player_b_id)

    assert sync[0]["payload"]["drawn_pile_top"] is None


@pytest.mark.asyncio
async def test_state_sync_includes_cards_remaining_count(
    test_client: TestClient, patch_redis, local_broadcast
):
    room_id = f"sync-remaining-{uuid4()}"

    def seed(state):
        state.players = [
            Player(id="p0", name="A", seat=0),
            Player(id="p1", name="B", seat=1),
        ]
        state.phase = GamePhase.IN_PROGRESS
        state.deck = [Card(rank=Rank.TWO, suit=Suit.CLUBS) for _ in range(49)]
        state.drawn_pile = [Card(rank=Rank.ACE, suit=Suit.SPADES) for _ in range(3)]
        return EngineResult(state=state, events=[])

    await apply_with_lock(room_id, seed)

    with test_client.websocket_connect(f"/ws/{room_id}") as ws:
        ws.send_json(
            {
                "type": "join",
                "action_id": str(uuid4()),
                "player_name": "Observer",
                "resume_token": "p1",
            }
        )
        sync = None
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            msg = ws.receive_json()
            if msg.get("type") == "state_sync":
                sync = msg
                break
        assert sync is not None

    assert sync["payload"]["cards_remaining"] == 49
