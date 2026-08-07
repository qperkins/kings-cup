"""
Per-player token bucket rate limiting, keyed by player_id in Redis.

The token bucket refills continuously at a fixed rate, up to a maximum
capacity. Each message consumes one token. When tokens are exhausted, the
client is rate-limited until enough time passes for tokens to refill.

All Redis operations are wrapped in retry_with_backoff exactly like
room_store.py, so the rate limiter survives transient connection errors
during Sentinel failover.

CRITICAL: Uses atomic Lua script (EVAL) for the entire GET-calculate-SET
operation. Without atomicity, two concurrent requests for the same player_id
would race: both read tokens=5, both calculate 5-1=4, both write tokens=4,
effectively giving the client 2x their quota. This is the identical race
condition that room_store.py's distributed lock prevents for game state.
"""
from __future__ import annotations

from fastapi import WebSocket
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError

from .redis_client import get_master
from .retry import retry_with_backoff

_BUCKET_CAPACITY = 10
_REFILL_RATE_PER_SECOND = 5.0

_TRANSIENT_REDIS_ERRORS = (RedisConnectionError, RedisTimeoutError)

# Atomic token bucket implementation via Lua script.
# Redis executes Lua scripts atomically server-side, so the entire
# GET-calculate-SET becomes one indivisible operation with no window
# for another request to interleave.
_TOKEN_BUCKET_SCRIPT = """
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local ttl_s = tonumber(ARGV[3])

-- CRITICAL: Use Redis TIME, not Python time.monotonic()
-- time.monotonic() has no shared reference point across app instances,
-- so passing it as an arg would produce garbage elapsed-time values
-- when instance A writes the bucket and instance B reads it later.
local time = redis.call('TIME')
local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local state = redis.call('GET', key)
local tokens, last_refill_ms

if state then
  local decoded = cjson.decode(state)
  tokens = decoded.tokens
  last_refill_ms = decoded.last_refill_ms
else
  tokens = capacity
  last_refill_ms = now_ms
end

local elapsed_s = (now_ms - last_refill_ms) / 1000.0
tokens = math.min(capacity, tokens + elapsed_s * refill_rate)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('SET', key, cjson.encode({tokens = tokens, last_refill_ms = now_ms}), 'EX', ttl_s)
return allowed
"""


def _rate_limit_key(player_id: str) -> str:
    return f"rate_limit:{player_id}"


def _connection_key(websocket: WebSocket) -> str:
    """Key purely by client IP for pre-join rate limiting.
    
    CRITICAL: Do NOT include id(websocket) in the key. Including it would give
    every new connection a fresh bucket, so an attacker opening many connections
    (the actual attack this defends against) would bypass the limit entirely.
    
    Key only by client_host, which FastAPI populates from X-Real-IP / 
    X-Forwarded-For headers when --proxy-headers is enabled (see Dockerfile).
    """
    client_host = websocket.client.host if websocket.client else "unknown"
    return f"rate_limit:conn:{client_host}"


async def check_rate_limit(player_id: str) -> bool:
    """Check if player has tokens available, decrement if so, return allowed status.
    
    Returns True if the message is allowed (tokens available), False if rate-limited.
    
    Uses atomic Lua script to prevent race conditions across multiple app instances.
    """
    key = _rate_limit_key(player_id)
    
    async def _eval():
        redis = get_master()
        result = await redis.eval(
            _TOKEN_BUCKET_SCRIPT,
            1,
            key,
            _BUCKET_CAPACITY,
            _REFILL_RATE_PER_SECOND,
            60,
        )
        return bool(result)
    
    return await retry_with_backoff(_eval, retryable_exceptions=_TRANSIENT_REDIS_ERRORS)


async def check_connection_rate_limit(websocket: WebSocket) -> bool:
    """Rate limit by connection before player_id exists. Uses same token bucket
    but higher capacity (20) to prevent join spam DoS.
    
    TRADEOFF: King's Cup is an in-person game where multiple legitimate players
    often share the same WiFi (same public IP). A group of 6+ friends all tapping
    "join" within 1-2 seconds is a realistic scenario, not an attack. 
    
    Capacity of 20 allows ~6 simultaneous joins plus some room for reconnects,
    while still blocking a true flood (hundreds of requests). A malicious actor
    could still exhaust this, but that's acceptable: they'd need to sustain
    10 req/sec (refill rate) to keep it depleted, which triggers other observable
    DoS signals (bandwidth, Redis load) that ops would notice independently.
    """
    key = _connection_key(websocket)
    
    # Higher capacity for legitimate multi-player scenarios: 20 tokens, 10/sec refill
    async def _eval():
        redis = get_master()
        result = await redis.eval(
            _TOKEN_BUCKET_SCRIPT,
            1,
            key,
            20,
            10.0,
            60,
        )
        return bool(result)
    
    return await retry_with_backoff(_eval, retryable_exceptions=_TRANSIENT_REDIS_ERRORS)
