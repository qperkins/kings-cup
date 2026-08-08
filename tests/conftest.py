"""Pytest fixtures for in-process tests with a real Redis instance."""
from __future__ import annotations

import asyncio
import io
import os
from collections.abc import Iterator
from unittest.mock import patch

import pytest
import redis
import redis.asyncio as aioredis
from starlette.testclient import TestClient

from game_engine.connection_manager import ConnectionManager
from game_engine.main import app

TEST_REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/15")


class _LoopLocalRedis:
    """Async Redis client bound to whichever event loop is currently running."""

    def __init__(self, url: str) -> None:
        self._url = url
        self._clients: dict[int, aioredis.Redis] = {}

    def __call__(self) -> aioredis.Redis:
        loop = asyncio.get_running_loop()
        key = id(loop)
        if key not in self._clients:
            self._clients[key] = aioredis.from_url(self._url, decode_responses=False)
        return self._clients[key]


@pytest.fixture(autouse=True)
def wide_event_capture() -> Iterator[io.StringIO]:
    """Capture WideEvent JSON lines in memory (handler binds stdout at import time)."""
    import game_engine.logging_utils as lu

    buffer = io.StringIO()
    original = lu._handler.stream
    lu._handler.stream = buffer
    yield buffer
    lu._handler.stream = original


@pytest.fixture(autouse=True)
def fresh_connection_manager() -> Iterator[None]:
    """Each test gets an isolated ConnectionManager — the module singleton is shared."""
    import game_engine.main as main

    main.manager = ConnectionManager()
    yield
    for task in main.manager._subscriptions.values():
        task.cancel()
    main.manager._subscriptions.clear()
    main.manager._rooms.clear()


@pytest.fixture
def local_broadcast(fresh_connection_manager) -> Iterator[None]:
    """Bypass Redis pub/sub — deliver broadcasts in-process (TestClient is single-process)."""
    import game_engine.main as main

    async def _local_publish(room_id: str, event) -> None:
        await main.manager._deliver_local(room_id, event)

    main.manager.publish = _local_publish  # type: ignore[method-assign]
    yield


@pytest.fixture
def patch_redis() -> Iterator[_LoopLocalRedis]:
    """Route get_master/get_replica to a loop-local test Redis DB."""
    sync_client = redis.from_url(TEST_REDIS_URL, decode_responses=False)
    try:
        sync_client.ping()
    except Exception as exc:
        pytest.skip(f"Redis not available at {TEST_REDIS_URL}: {exc}")

    sync_client.flushdb()
    loop_local = _LoopLocalRedis(TEST_REDIS_URL)

    with (
        patch("game_engine.room_store.get_master", loop_local),
        patch("game_engine.redis_client.get_master", loop_local),
        patch("game_engine.connection_manager.get_master", loop_local),
        patch("game_engine.connection_manager.get_replica", loop_local),
        patch("game_engine.rate_limiter.get_master", loop_local),
        patch("game_engine.main.get_master", loop_local),
    ):
        yield loop_local

    sync_client.flushdb()
    sync_client.close()


@pytest.fixture
def test_client(patch_redis: _LoopLocalRedis) -> Iterator[TestClient]:
    with TestClient(app) as client:
        yield client


@pytest.fixture
def ws_server(patch_redis, local_broadcast) -> Iterator[str]:
    """In-process uvicorn for multi-client websocket tests (TestClient supports only one WS)."""
    from tests.ws_helpers import live_server

    with live_server() as url:
        yield url
