"""
Centralized room state, shared across every app instance via Redis.

Why a lock is required: with two app instances behind a load balancer,
two players in the same room could have their actions land on different
instances at nearly the same moment. Without coordination, both instances
would read the same GameState, apply their action independently, and the
second write would silently clobber the first (e.g. two "draw_card"
actions both thinking the deck has 30 cards left, when it actually only
has 29 after the first one applied). A per-room lock serializes
read-modify-write cycles across instances.

This is a simple SET NX PX lock (single Redis primary as the
coordinator) -- not a full Redlock across multiple independent Redis
masters. That's a deliberate, explainable scope choice: correct as long
as there's one authoritative primary at a time, which Sentinel guarantees
except for the brief window during failover itself -- which is exactly
the window `retry_with_backoff` below is there to ride out.
"""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from uuid import uuid4

from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError

from .models import GameState
from .redis_client import get_master
from .retry import RetriesExhausted, retry_with_backoff

_LOCK_TTL_MS = 3000
_LOCK_WAIT_MAX_ATTEMPTS = 20   # ~ a couple seconds of jittered polling, worst case
_LOCK_WAIT_BASE_DELAY_S = 0.03
_LOCK_WAIT_MAX_DELAY_S = 0.25

# Transient failures worth retrying: connection drops and timeouts, which is
# exactly what you see for a second or two during Sentinel failover while the
# new master is being discovered. NOT retried: business-logic errors
# (EngineError) -- those are correct rejections, not transient failures, and
# retrying them would just repeat the same illegal action.
_TRANSIENT_REDIS_ERRORS = (RedisConnectionError, RedisTimeoutError)


def _state_key(room_id: str) -> str:
    return f"room:{room_id}:state"


async def load_state(room_id: str) -> GameState:
    async def _op():
        redis = get_master()
        raw = await redis.get(_state_key(room_id))
        if raw is None:
            return GameState(room_id=room_id)
        data = json.loads(raw)
        data["processed_action_ids"] = set(data.get("processed_action_ids", []))
        return GameState.model_validate(data)

    return await retry_with_backoff(_op, retryable_exceptions=_TRANSIENT_REDIS_ERRORS)


async def save_state(state: GameState) -> None:
    async def _op():
        redis = get_master()
        payload = state.model_dump(mode="json")
        payload["processed_action_ids"] = list(state.processed_action_ids)
        await redis.set(_state_key(state.room_id), json.dumps(payload))

    await retry_with_backoff(_op, retryable_exceptions=_TRANSIENT_REDIS_ERRORS)


@asynccontextmanager
async def room_lock(room_id: str):
    """Acquire a per-room lock with jittered polling, yield, always release.

    Jitter matters here specifically: if three instances are all waiting on
    the same room's lock, fixed-interval polling means all three retry on
    the same tick forever, repeatedly colliding. Randomizing each wait
    spreads them out so one of them wins promptly instead of all three
    livelocking.
    """
    redis = get_master()
    lock_key = f"room:{room_id}:lock"
    token = str(uuid4())

    async def _try_acquire():
        acquired = await redis.set(lock_key, token, nx=True, px=_LOCK_TTL_MS)
        if not acquired:
            raise LockContended(room_id)
        return True

    try:
        await retry_with_backoff(
            _try_acquire,
            max_attempts=_LOCK_WAIT_MAX_ATTEMPTS,
            base_delay_s=_LOCK_WAIT_BASE_DELAY_S,
            max_delay_s=_LOCK_WAIT_MAX_DELAY_S,
            retryable_exceptions=(LockContended,) + _TRANSIENT_REDIS_ERRORS,
        )
    except RetriesExhausted as exc:
        raise TimeoutError(f"Could not acquire lock for room {room_id}") from exc

    try:
        yield
    finally:
        # Only release if we still hold it (token matches) -- avoids releasing
        # a lock some other instance acquired after ours expired mid-hold.
        current = await redis.get(lock_key)
        if current is not None and current.decode() == token:
            await redis.delete(lock_key)


class LockContended(Exception):
    """Internal signal used to drive retry_with_backoff for lock polling --
    not a real error, just "someone else has it, try again"."""
    def __init__(self, room_id: str):
        super().__init__(f"room {room_id} lock held by another instance")


async def apply_with_lock(room_id: str, fn):
    """Load state under lock, run fn(state) -> EngineResult, persist, release.
    This is the only path main.py should use to mutate room state once
    you're running more than one instance."""
    async with room_lock(room_id):
        state = await load_state(room_id)
        result = fn(state)
        await save_state(result.state)
        return result
