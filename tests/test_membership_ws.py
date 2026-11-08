"""WebSocket-level tests: identity is bound to the socket, kick/leave reach clients."""
from __future__ import annotations

import json
from uuid import uuid4

import pytest
import websockets

from tests.ws_helpers import join_and_sync, recv_all_pending, recv_until


async def _send(ws, **msg):
    await ws.send(json.dumps({"action_id": str(uuid4()), **msg}))


async def _error(ws):
    m = await recv_until(ws, lambda m: m.get("type") == "error")
    return m["payload"]["detail"]


@pytest.mark.asyncio
async def test_socket_cannot_act_with_another_players_id(ws_server):
    room = f"idbind-{uuid4()}"
    async with websockets.connect(f"{ws_server}/ws/{room}") as host, websockets.connect(f"{ws_server}/ws/{room}") as bob:
        _, host_id = await join_and_sync(host, "Host")
        _, bob_id = await join_and_sync(bob, "Bob")
        await recv_all_pending(host)
        await recv_all_pending(bob)
        await _send(host, type="start_game")
        await recv_until(bob, lambda m: m.get("type") == "game_started")

        for intent in ({"type": "restart_game"}, {"type": "end_game"},
                       {"type": "kick_player", "target_id": host_id},
                       {"type": "make_host", "target_id": bob_id}):
            await _send(bob, player_id=host_id, **intent)  # Bob's socket, Host's id
            assert "does not match" in await _error(bob), intent


@pytest.mark.asyncio
async def test_intent_before_join_is_rejected(ws_server):
    room = f"nojoin-{uuid4()}"
    async with websockets.connect(f"{ws_server}/ws/{room}") as ws:
        await _send(ws, type="start_game")
        assert "Join the room first" in await _error(ws)


@pytest.mark.asyncio
async def test_kicked_player_is_told_then_disconnected_and_cannot_resume(ws_server):
    room = f"kick-{uuid4()}"
    async with websockets.connect(f"{ws_server}/ws/{room}") as host, \
            websockets.connect(f"{ws_server}/ws/{room}") as bob, \
            websockets.connect(f"{ws_server}/ws/{room}") as cara:
        _, host_id = await join_and_sync(host, "Host")
        _, bob_id = await join_and_sync(bob, "Bob")
        _, cara_id = await join_and_sync(cara, "Cara")
        await _send(host, type="start_game")
        await recv_until(cara, lambda m: m.get("type") == "game_started")
        await recv_all_pending(bob)

        await _send(host, type="kick_player", player_id=host_id, target_id=bob_id)
        removed = await recv_until(bob, lambda m: m.get("type") == "player_removed")
        assert removed["payload"]["player_id"] == bob_id and removed["payload"]["reason"] == "kicked"
        seen_by_cara = await recv_until(cara, lambda m: m.get("type") == "player_removed")
        assert [p["id"] for p in seen_by_cara["payload"]["players"]] == [host_id, cara_id]

        # server closes the kicked socket
        with pytest.raises(websockets.ConnectionClosed):
            for _ in range(5):
                await bob.recv()

        # a fresh socket resuming as Bob is refused
        async with websockets.connect(f"{ws_server}/ws/{room}") as again:
            await _send(again, type="join", player_name="Bob", resume_token=bob_id)
            assert "removed" in await _error(again)


@pytest.mark.asyncio
async def test_mid_game_join_leave_and_host_handoff(ws_server):
    room = f"flow-{uuid4()}"
    async with websockets.connect(f"{ws_server}/ws/{room}") as host, websockets.connect(f"{ws_server}/ws/{room}") as bob:
        _, host_id = await join_and_sync(host, "Host")
        _, bob_id = await join_and_sync(bob, "Bob")
        await _send(host, type="start_game")
        await recv_until(bob, lambda m: m.get("type") == "game_started")

        async with websockets.connect(f"{ws_server}/ws/{room}") as late:
            sync, late_id = await join_and_sync(late, "Late")
            assert sync["payload"]["phase"] == "in_progress"
            assert sync["payload"]["host_id"] == host_id
            await recv_until(host, lambda m: m.get("type") == "player_joined")

            await _send(host, type="make_host", player_id=host_id, target_id=late_id)
            changed = await recv_until(late, lambda m: m.get("type") == "host_changed")
            assert changed["payload"]["host_id"] == late_id

            await _send(late, type="leave_room", player_id=late_id)
            left = await recv_until(host, lambda m: m.get("type") == "player_removed")
            assert left["payload"]["reason"] == "left"
            # the departing host's role passes to the lowest remaining seat
            assert left["payload"]["host_id"] == host_id


@pytest.mark.asyncio
async def test_only_host_socket_can_start_game(ws_server):
    """start_game has no player_id field, so the server authorizes by socket."""
    room = f"startauth-{uuid4()}"
    async with websockets.connect(f"{ws_server}/ws/{room}") as host, websockets.connect(f"{ws_server}/ws/{room}") as bob:
        await join_and_sync(host, "Host")
        await join_and_sync(bob, "Bob")
        await recv_all_pending(host)
        await recv_all_pending(bob)
        await _send(bob, type="start_game")
        assert "Only the host" in await _error(bob)
        await _send(host, type="start_game")
        await recv_until(bob, lambda m: m.get("type") == "game_started")
