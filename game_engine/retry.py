"""
Full-jitter exponential backoff, per the AWS Builders' Library pattern
(Marc Brooker, "Timeouts, retries, and backoff with jitter"):
https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter

Two failure modes in this codebase need this, and they're different:

1. Transient Redis errors (ConnectionError/TimeoutError) -- e.g. the ~second
   or two during a Sentinel failover where the old master is gone and the
   new one hasn't been discovered yet. These should retry a few times with
   backoff and then give up loudly.
2. Room-lock contention -- another instance is mid-write on the same room.
   This isn't a failure, it's expected under concurrent load, but polling
   at a fixed interval means every waiter retries in lockstep and they all
   collide again on the next tick. Jitter fixes that.

Both use the same primitive: don't retry at a fixed interval, and don't
retry with pure exponential backoff either (that still synchronizes
retries across callers who started waiting at the same time) -- pick a
random delay in [0, min(cap, base * 2^attempt)) every attempt.
"""
from __future__ import annotations

import asyncio
import logging
import random
from typing import Awaitable, Callable, TypeVar

T = TypeVar("T")

logger = logging.getLogger("kings_cup.retry")


class RetriesExhausted(Exception):
    def __init__(self, attempts: int, last_error: Exception):
        super().__init__(f"Gave up after {attempts} attempts: {last_error!r}")
        self.attempts = attempts
        self.last_error = last_error


async def retry_with_backoff(
    operation: Callable[[], Awaitable[T]],
    *,
    max_attempts: int = 5,
    base_delay_s: float = 0.05,
    max_delay_s: float = 2.0,
    retryable_exceptions: tuple[type[Exception], ...] = (Exception,),
    on_retry: Callable[[int, Exception, float], None] | None = None,
) -> T:
    """Full-jitter retry. Raises RetriesExhausted (chaining the last error)
    if every attempt fails. Every call site should also have its own
    per-attempt timeout on `operation` itself -- backoff without a timeout
    just means you wait longer before failing, it doesn't bound the wait."""
    last_error: Exception | None = None

    for attempt in range(1, max_attempts + 1):
        try:
            return await operation()
        except retryable_exceptions as exc:  # noqa: BLE001 - intentionally broad, narrowed by caller
            last_error = exc
            if attempt == max_attempts:
                break
            delay = random.uniform(0, min(max_delay_s, base_delay_s * (2 ** (attempt - 1))))
            if on_retry:
                on_retry(attempt, exc, delay)
            else:
                logger.warning(
                    "retry attempt=%d/%d delay_s=%.3f error=%r",
                    attempt, max_attempts, delay, exc,
                )
            await asyncio.sleep(delay)

    assert last_error is not None
    raise RetriesExhausted(max_attempts, last_error) from last_error
