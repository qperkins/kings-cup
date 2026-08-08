"""Unit tests for game_engine.retry."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from game_engine.engine import EngineError
from game_engine.retry import RetriesExhausted, retry_with_backoff
from redis.exceptions import ConnectionError as RedisConnectionError


@pytest.mark.asyncio
async def test_full_jitter_delays_stay_within_bounds():
    base_delay_s = 0.1
    max_delay_s = 2.0
    uniform_calls: list[tuple[float, float]] = []
    sleep_delays: list[float] = []

    def capture_uniform(lo: float, hi: float) -> float:
        uniform_calls.append((lo, hi))
        return (lo + hi) / 2

    async def always_fail():
        raise RedisConnectionError("transient")

    with patch("game_engine.retry.random.uniform", side_effect=capture_uniform):
        with patch(
            "game_engine.retry.asyncio.sleep",
            AsyncMock(side_effect=lambda d: sleep_delays.append(d)),
        ):
            with pytest.raises(RetriesExhausted):
                await retry_with_backoff(
                    always_fail,
                    max_attempts=10,
                    base_delay_s=base_delay_s,
                    max_delay_s=max_delay_s,
                    retryable_exceptions=(RedisConnectionError,),
                )

    for i, (lo, hi) in enumerate(uniform_calls, start=1):
        upper = min(max_delay_s, base_delay_s * (2 ** (i - 1)))
        assert lo == 0
        assert hi == upper

    for delay, (_, hi) in zip(sleep_delays, uniform_calls, strict=True):
        assert 0 <= delay <= hi

    for target_attempt in range(1, 10):
        expected_upper = min(max_delay_s, base_delay_s * (2 ** (target_attempt - 1)))
        for _ in range(1000):
            attempt_idx = 0
            seen_bounds: tuple[float, float] | None = None

            def capture_uniform(lo: float, hi: float) -> float:
                nonlocal attempt_idx, seen_bounds
                attempt_idx += 1
                if attempt_idx == target_attempt:
                    seen_bounds = (lo, hi)
                return (lo + hi) / 2

            with patch("game_engine.retry.random.uniform", side_effect=capture_uniform):
                with patch("game_engine.retry.asyncio.sleep", new_callable=AsyncMock):
                    with pytest.raises(RetriesExhausted):
                        await retry_with_backoff(
                            always_fail,
                            max_attempts=target_attempt + 1,
                            base_delay_s=base_delay_s,
                            max_delay_s=max_delay_s,
                            retryable_exceptions=(RedisConnectionError,),
                        )

            assert seen_bounds is not None
            lo, hi = seen_bounds
            assert lo == 0
            assert hi == expected_upper


@pytest.mark.asyncio
async def test_non_retryable_exception_not_retried():
    calls = 0

    async def illegal_move():
        nonlocal calls
        calls += 1
        raise EngineError("illegal move")

    with pytest.raises(EngineError, match="illegal move"):
        await retry_with_backoff(
            illegal_move,
            max_attempts=5,
            retryable_exceptions=(RedisConnectionError,),
        )

    assert calls == 1


@pytest.mark.asyncio
async def test_retryable_exception_exhausts_attempts_then_raises():
    calls = 0

    async def always_fail():
        nonlocal calls
        calls += 1
        raise RedisConnectionError("down")

    with patch("game_engine.retry.asyncio.sleep", new_callable=AsyncMock):
        with pytest.raises(RetriesExhausted) as exc_info:
            await retry_with_backoff(
                always_fail,
                max_attempts=3,
                retryable_exceptions=(RedisConnectionError,),
            )

    assert calls == 3
    assert isinstance(exc_info.value.last_error, RedisConnectionError)


@pytest.mark.asyncio
async def test_successful_operation_returns_immediately():
    calls = 0

    async def succeed():
        nonlocal calls
        calls += 1
        return "success"

    with patch("game_engine.retry.asyncio.sleep", new_callable=AsyncMock) as sleep_mock:
        result = await retry_with_backoff(succeed, max_attempts=5)

    assert result == "success"
    assert calls == 1
    sleep_mock.assert_not_called()
