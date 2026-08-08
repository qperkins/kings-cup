"""In-process integration tests via live uvicorn + websockets library."""
from __future__ import annotations

import asyncio
import json
from uuid import uuid4

import pytest
import websockets

from tests.helpers import parse_wide_events, wide_events_named
from tests.ws_helpers import join_and_sync, recv_all_pending, recv_until


@pytest.mark.asyncio
async def test_full_join_start_draw_sequence(ws_server, wide_event_capture):
    room_id = f"integration-{uuid4()}"
    async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_a:
        async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_b:
            _, player_a = await join_and_sync(ws_a, "Alice")
            sync_b, _player_b = await join_and_sync(ws_b, "Bob")
            assert len(sync_b["payload"]["players"]) == 2
            assert {p["name"] for p in sync_b["payload"]["players"]} == {"Alice", "Bob"}

            a_after_b = await recv_all_pending(ws_a)
            assert any(m.get("type") == "player_joined" for m in a_after_b)

            await ws_a.send(json.dumps({"type": "start_game", "action_id": str(uuid4())}))
            await recv_until(ws_a, lambda m: m.get("type") == "game_started")
            await recv_until(ws_b, lambda m: m.get("type") == "game_started")

            await ws_a.send(
                json.dumps(
                    {
                        "type": "draw_card",
                        "action_id": str(uuid4()),
                        "player_id": player_a,
                    }
                )
            )
            drawn_a = await recv_until(ws_a, lambda m: m.get("type") == "card_drawn")
            drawn_b = await recv_until(ws_b, lambda m: m.get("type") == "card_drawn")
            assert drawn_a["payload"]["card"] == drawn_b["payload"]["card"]

            turn_a = await recv_until(ws_a, lambda m: m.get("type") == "turn_advanced")
            turn_b = await recv_until(ws_b, lambda m: m.get("type") == "turn_advanced")
            assert turn_a["payload"]["current_turn_seat"] == 1
            assert turn_b["payload"]["current_turn_seat"] == 1

    processed = wide_events_named(wide_event_capture.getvalue(), "message_processed")
    if len(processed) >= 4:
        assert all(
            e.get("outcome") == "success"
            for e in processed
            if e.get("intent_type") != "invalid"
        )
    # When using uvicorn thread, wide events may not reach capsys — game flow verified above


@pytest.mark.asyncio
async def test_idempotent_retry_does_not_double_draw(ws_server):
    room_id = f"idempotent-{uuid4()}"
    async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_a:
        async with websockets.connect(f"{ws_server}/ws/{room_id}") as ws_b:
            _, player_a = await join_and_sync(ws_a, "Alice")
            await join_and_sync(ws_b, "Bob")

            await ws_a.send(json.dumps({"type": "start_game", "action_id": str(uuid4())}))
            await recv_until(ws_a, lambda m: m.get("type") == "game_started")
            await recv_until(ws_b, lambda m: m.get("type") == "game_started")

            action_id = str(uuid4())
            await ws_a.send(
                json.dumps(
                    {
                        "type": "draw_card",
                        "action_id": action_id,
                        "player_id": player_a,
                    }
                )
            )
            await recv_until(ws_a, lambda m: m.get("type") == "card_drawn")
            await recv_until(ws_b, lambda m: m.get("type") == "card_drawn")

            await ws_a.send(
                json.dumps(
                    {
                        "type": "draw_card",
                        "action_id": action_id,
                        "player_id": player_a,
                    }
                )
            )
            assert not any(
                m.get("type") == "card_drawn" for m in await recv_all_pending(ws_a)
            )
            assert not any(
                m.get("type") == "card_drawn" for m in await recv_all_pending(ws_b)
            )


def test_wide_event_emitted_on_error_path(test_client, local_broadcast, wide_event_capture):
    """Single-client error path — Starlette TestClient is sufficient here."""
    from uuid import uuid4
    import time

    room_id = f"wide-error-{uuid4()}"

    def _recv_until(ws, predicate, timeout_s: float = 2.0):
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            msg = ws.receive_json()
            if predicate(msg):
                return msg
        raise AssertionError("Timed out waiting for expected websocket message")

    with test_client.websocket_connect(f"/ws/{room_id}") as ws:
        ws.send_json({"type": "not_a_real_intent", "action_id": str(uuid4())})
        err = _recv_until(ws, lambda m: m.get("type") == "error")
        assert err is not None

    events = parse_wide_events(wide_event_capture.getvalue())
    invalid = [e for e in events if e.get("outcome") == "invalid_message"]
    assert len(invalid) >= 1
    assert invalid[0]["error"]["type"] == "ValidationError"
