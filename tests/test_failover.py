"""
Failover tests — require the full docker-compose Sentinel stack to already be running.

Prerequisite:
  docker compose up

These tests connect through nginx at ws://localhost:8080. If the endpoint is
unreachable, tests are skipped with a clear message rather than failing
confusingly.

Note on wide-event assertions: the in-process flaky-Redis tests use wide_event_capture
(not container stdout) to verify retry logging during Sentinel-style transient failures.
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Callable
from uuid import uuid4

import pytest
import websockets
from starlette.testclient import TestClient

from tests.helpers import wide_events_named, websocket_sessions

FAILOVER_WS_URL = "ws://localhost:8080"


def _recv_until(ws, predicate, timeout_s: float = 2.0):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        msg = ws.receive_json()
        if predicate(msg):
            return msg
    raise AssertionError("Timed out waiting for expected websocket message")


def _flaky_redis_factory(
    patch_redis,
    *,
    key_predicate: Callable[[str, dict], bool],
    fail_on_match: Callable[[], bool] | None = None,
) -> tuple[Callable[[], object], dict]:
    """Return (get_flaky_master, stats). stats['matching_calls'] counts matched set() calls."""
    from redis.exceptions import ConnectionError as RedisConnectionError

    stats = {"matching_calls": 0, "failures_injected": 0}

    def get_flaky_master():
        redis = patch_redis()
        if getattr(redis, "_flaky_set_patched", False):
            return redis

        original_set = redis.set

        async def flaky_set(*args, **kwargs):
            key = args[0] if args else ""
            if isinstance(key, (bytes, bytearray)):
                key = key.decode()
            if key_predicate(str(key), kwargs) and (
                fail_on_match is None or fail_on_match()
            ):
                stats["matching_calls"] += 1
                if stats["failures_injected"] == 0:
                    stats["failures_injected"] += 1
                    raise RedisConnectionError("simulated failover window")
            return await original_set(*args, **kwargs)

        redis.set = flaky_set  # type: ignore[method-assign]
        redis._flaky_set_patched = True
        return redis

    return get_flaky_master, stats


def _send_draw_and_recv(ws_a, player_a) -> dict:
    ws_a.send_json(
        {
            "type": "draw_card",
            "action_id": str(uuid4()),
            "player_id": player_a,
        }
    )
    while True:
        msg = ws_a.receive_json()
        if msg["type"] in ("card_drawn", "error"):
            return msg


async def _can_reach_failover_stack() -> bool:
    try:
        room_id = f"failover-probe-{uuid4()}"
        async with websockets.connect(
            f"{FAILOVER_WS_URL}/ws/{room_id}",
            open_timeout=5,
        ) as ws:
            await ws.send(
                json.dumps(
                    {
                        "type": "join",
                        "action_id": str(uuid4()),
                        "player_name": "probe",
                    }
                )
            )
            await asyncio.wait_for(ws.recv(), timeout=5)
        return True
    except Exception:
        return False


@pytest.fixture(scope="module")
def failover_stack_available():
    if not asyncio.run(_can_reach_failover_stack()):
        pytest.skip(
            "Failover stack not reachable at ws://localhost:8080 — "
            "start it with: docker compose up"
        )


async def _ws_join(ws, name: str) -> str:
    await ws.send(
        json.dumps(
            {
                "type": "join",
                "action_id": str(uuid4()),
                "player_name": name,
            }
        )
    )
    while True:
        msg = json.loads(await ws.recv())
        if msg.get("type") == "state_sync":
            return msg["payload"]["your_player_id"]


async def _ws_recv_until(ws, event_type: str, timeout_s: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=min(5.0, deadline - time.monotonic())))
        if msg.get("type") == event_type:
            return msg
    raise TimeoutError(f"Timed out waiting for {event_type!r}")


@pytest.mark.asyncio
async def test_sentinel_failover_mid_game_succeeds_or_fails_cleanly(failover_stack_available):
    room_id = f"failover-{uuid4()}"

    async with websockets.connect(f"{FAILOVER_WS_URL}/ws/{room_id}") as ws_a:
        player_a = await _ws_join(ws_a, "Alice")

        async with websockets.connect(f"{FAILOVER_WS_URL}/ws/{room_id}") as ws_b:
            await _ws_join(ws_b, "Bob")

            await ws_a.send(json.dumps({"type": "start_game", "action_id": str(uuid4())}))
            await _ws_recv_until(ws_a, "game_started")
            await _ws_recv_until(ws_b, "game_started")

            await ws_a.send(
                json.dumps(
                    {
                        "type": "draw_card",
                        "action_id": str(uuid4()),
                        "player_id": player_a,
                    }
                )
            )
            await _ws_recv_until(ws_a, "card_drawn")
            await _ws_recv_until(ws_b, "card_drawn")

        # redis-primary kill is expected to be performed manually or by CI orchestration
        # before this draw attempt when running the full failover scenario.
        draw_action_id = str(uuid4())
        outcomes: list[str] = []

        for attempt in range(3):
            await ws_a.send(
                json.dumps(
                    {
                        "type": "draw_card",
                        "action_id": draw_action_id,
                        "player_id": player_a,
                    }
                )
            )
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                msg = json.loads(await asyncio.wait_for(ws_a.recv(), timeout=5))
                msg_type = msg.get("type")
                if msg_type == "card_drawn":
                    outcomes.append("card_drawn")
                    break
                if msg_type == "error":
                    outcomes.append("error")
                    break
            else:
                outcomes.append("timeout")
                break
            if outcomes[-1] == "card_drawn":
                break

        card_drawn_count = outcomes.count("card_drawn")
        assert card_drawn_count <= 1
        assert outcomes[-1] in ("card_drawn", "error")


def test_failover_save_state_retry_visible_in_wide_events(
    test_client: TestClient, local_broadcast, wide_event_capture, patch_redis
):
    """Transient Redis failure on save_state during draw_card is retried and logged."""
    from unittest.mock import patch

    room_id = f"wide-retry-state-{uuid4()}"
    get_flaky_master, stats = _flaky_redis_factory(
        patch_redis,
        key_predicate=lambda key, _: ":state" in key,
    )

    with patch("game_engine.room_store.get_master", get_flaky_master):
        stack, (ws_a, ws_b) = websocket_sessions(f"/ws/{room_id}", f"/ws/{room_id}")
        with stack:
            ws_a.send_json(
                {"type": "join", "action_id": str(uuid4()), "player_name": "Alice"}
            )
            sync = _recv_until(ws_a, lambda m: m.get("type") == "state_sync")
            player_a = sync["payload"]["your_player_id"]

            ws_b.send_json(
                {"type": "join", "action_id": str(uuid4()), "player_name": "Bob"}
            )
            _recv_until(ws_b, lambda m: m.get("type") == "state_sync")

            ws_a.send_json({"type": "start_game", "action_id": str(uuid4())})
            while ws_a.receive_json()["type"] != "game_started":
                pass
            while ws_b.receive_json()["type"] != "game_started":
                pass

            draw_result = _send_draw_and_recv(ws_a, player_a)

    assert draw_result["type"] == "card_drawn"
    processed = wide_events_named(wide_event_capture.getvalue(), "message_processed")
    draw_events = [e for e in processed if e.get("intent_type") == "draw_card"]
    assert draw_events, "Expected a wide event for draw_card"
    assert draw_events[-1]["outcome"] == "success"
    assert draw_events[-1].get("lock_wait_ms", 0) >= 0
    assert stats["matching_calls"] >= 2
    assert stats["failures_injected"] == 1


def test_failover_lock_acquisition_retries_on_draw(
    test_client: TestClient, local_broadcast, wide_event_capture, patch_redis
):
    """Transient Redis failure acquiring room:{id}:lock during draw_card is retried."""
    from unittest.mock import patch

    room_id = f"wide-retry-lock-{uuid4()}"
    draw_phase = {"active": False}
    get_flaky_master, stats = _flaky_redis_factory(
        patch_redis,
        key_predicate=lambda key, kw: ":lock" in key and bool(kw.get("nx")),
        fail_on_match=lambda: draw_phase["active"],
    )

    with patch("game_engine.room_store.get_master", get_flaky_master):
        stack, (ws_a, ws_b) = websocket_sessions(f"/ws/{room_id}", f"/ws/{room_id}")
        with stack:
            ws_a.send_json(
                {"type": "join", "action_id": str(uuid4()), "player_name": "Alice"}
            )
            sync = _recv_until(ws_a, lambda m: m.get("type") == "state_sync")
            player_a = sync["payload"]["your_player_id"]

            ws_b.send_json(
                {"type": "join", "action_id": str(uuid4()), "player_name": "Bob"}
            )
            _recv_until(ws_b, lambda m: m.get("type") == "state_sync")

            ws_a.send_json({"type": "start_game", "action_id": str(uuid4())})
            while ws_a.receive_json()["type"] != "game_started":
                pass
            while ws_b.receive_json()["type"] != "game_started":
                pass

            draw_phase["active"] = True
            draw_result = _send_draw_and_recv(ws_a, player_a)

    assert draw_result["type"] == "card_drawn", draw_result
    assert stats["matching_calls"] >= 2, "lock acquisition should retry after transient failure"
    assert stats["failures_injected"] == 1

    processed = wide_events_named(wide_event_capture.getvalue(), "message_processed")
    draw_events = [e for e in processed if e.get("intent_type") == "draw_card"]
    assert draw_events, "Expected a wide event for draw_card"
    assert draw_events[-1]["outcome"] == "success"
    assert draw_events[-1].get("lock_wait_ms", 0) >= 0
