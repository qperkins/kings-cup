"""Tests for game_engine.rate_limiter — requires a real Redis instance."""
from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from redis.exceptions import ConnectionError as RedisConnectionError

from game_engine.rate_limiter import check_connection_rate_limit, check_rate_limit


def _mock_websocket(client_host: str) -> MagicMock:
    ws = MagicMock()
    ws.client.host = client_host
    return ws


@pytest.mark.asyncio
async def test_atomic_concurrency_same_player(patch_redis):
    player_id = f"p1-{uuid4()}"

    outcomes = await asyncio.gather(
        *[check_rate_limit(player_id) for _ in range(50)]
    )

    allowed = sum(1 for o in outcomes if o is True)
    limited = sum(1 for o in outcomes if o is False)

    assert allowed == 10
    assert limited == 40


@pytest.mark.asyncio
async def test_pre_join_key_shared_by_ip(patch_redis):
    client_ip = f"192.0.2.{uuid4().int % 250 + 1}"
    connections = [_mock_websocket(client_ip) for _ in range(3)]

    async def connection_checks(ws: MagicMock, count: int):
        return await asyncio.gather(
            *[check_connection_rate_limit(ws) for _ in range(count)]
        )

    batch1, batch2, batch3 = await asyncio.gather(
        connection_checks(connections[0], 10),
        connection_checks(connections[1], 10),
        connection_checks(connections[2], 10),
    )
    all_outcomes = list(batch1) + list(batch2) + list(batch3)
    allowed = sum(1 for o in all_outcomes if o is True)

    assert allowed <= 20


@pytest.mark.asyncio
async def test_refill_uses_redis_clock_not_client_time(patch_redis):
    player_id = f"refill-{uuid4()}"

    for _ in range(10):
        assert await check_rate_limit(player_id) is True
    assert await check_rate_limit(player_id) is False

    await asyncio.sleep(1.0)
    outcomes = await asyncio.gather(
        *[check_rate_limit(player_id) for _ in range(5)]
    )
    assert sum(1 for o in outcomes if o is True) == 5
    assert all(
        o is False
        for o in await asyncio.gather(
            *[check_rate_limit(player_id) for _ in range(5)]
        )
    )

    await asyncio.sleep(1.0)
    outcomes = await asyncio.gather(
        *[check_rate_limit(player_id) for _ in range(5)]
    )
    assert sum(1 for o in outcomes if o is True) == 5


@pytest.mark.asyncio
async def test_separate_buckets_per_player_post_join(patch_redis):
    p1 = f"p1-{uuid4()}"
    p2 = f"p2-{uuid4()}"

    for _ in range(10):
        assert await check_rate_limit(p1) is True
    assert await check_rate_limit(p1) is False

    p2_outcomes = await asyncio.gather(
        *[check_rate_limit(p2) for _ in range(10)]
    )
    assert all(o is True for o in p2_outcomes)


@pytest.mark.asyncio
async def test_rate_limiter_wrapped_in_retry_backoff(patch_redis):
    player_id = f"retry-{uuid4()}"
    call_count = 0
    redis_client = patch_redis()
    original_eval = redis_client.eval

    async def flaky_eval(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RedisConnectionError("transient")
        return await original_eval(*args, **kwargs)

    with patch.object(redis_client, "eval", side_effect=flaky_eval):
        outcome = await check_rate_limit(player_id)

    assert outcome is True
    assert call_count == 2
