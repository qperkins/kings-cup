# Rate Limiter Atomicity Fix - Implementation Summary

## What Was Fixed

Fixed critical read-modify-write race condition in the rate limiter and added pre-join protection against DoS attacks. All changes maintain consistency with the existing Sentinel/retry/wide-event patterns in the codebase.

## Critical Issues Addressed

### 1. Non-Atomic Token Bucket (Architecture Violation)

**Problem:** Original implementation used separate GET → calculate in Python → SET operations. Two concurrent requests for the same `player_id` could race:
- Both read `tokens=5`
- Both calculate `5-1=4` 
- Both write `tokens=4`
- Result: Client gets 2x their quota

This is the **identical failure mode** that `room_store.py`'s distributed lock exists to prevent. Having atomic game state coordination but non-atomic rate limiting creates an inconsistent architecture story.

**Solution:** Redis Lua script executes GET-calculate-SET atomically server-side. No window for interleaving requests.

### 2. Pre-Join Rate Limiting Gap

**Problem:** No rate limiting before `player_id` assignment. Attacker could flood unlimited join requests, each acquiring a room lock (DoS vector).

**Solution:** Added connection-based rate limiting keyed by client IP. Higher capacity (20 tokens, 10/sec refill) to handle legitimate shared-WiFi scenarios (King's Cup is in-person game, multiple friends on same network).

### 3. Cross-Instance Time Synchronization

**Problem:** Using Python `time.monotonic()` as Lua script argument would create garbage elapsed-time values across app instances (no shared reference point).

**Solution:** Lua script calls `redis.call('TIME')` internally for consistent timestamps.

### 4. Real Client IP Detection

**Problem:** Without proxy headers, `websocket.client.host` returns nginx's internal IP, breaking connection-based rate limiting.

**Solution:** 
- nginx forwards `X-Real-IP` and `X-Forwarded-For` headers
- uvicorn started with `--proxy-headers --forwarded-allow-ips=*`
- Wildcard acceptable because nginx is sole traffic source in compose network

## Files Changed

### Code Changes

1. **`game_engine/rate_limiter.py`** - Complete rewrite
   - Atomic Lua script using Redis TIME
   - `check_rate_limit(player_id)` - post-join rate limiting (10 capacity, 5/sec)
   - `check_connection_rate_limit(websocket)` - pre-join rate limiting (20 capacity, 10/sec)
   - Detailed comments explaining atomicity and shared-WiFi tradeoffs

2. **`game_engine/main.py`** - Added pre-join check
   - Import `check_connection_rate_limit`
   - Check connection rate limit before validation when `player_id is None`
   - Log `connection_rate_limited` field to WideEvent

### Infrastructure Created

3. **`nginx/nginx.conf`** - Load balancer config
   - Upstream pool: app1, app2
   - WebSocket upgrade headers
   - X-Real-IP / X-Forwarded-For forwarding

4. **`Dockerfile`** - Python FastAPI container
   - Python 3.11-slim base
   - uvicorn with `--proxy-headers --forwarded-allow-ips=*`
   - Comment explaining wildcard security tradeoff

5. **`docker-compose.yml`** - Full stack
   - 1 Redis primary, 1 replica
   - 3 Sentinel instances (quorum=2)
   - 2 app instances (app1, app2)
   - nginx load balancer (exposed on :8080)
   - Health checks and dependency ordering

6. **`requirements.txt`** - Python dependencies
   - fastapi, uvicorn[standard], redis[hiredis], pydantic

7. **`.dockerignore`** - Build optimization
   - Excludes frontend files, node_modules, documentation

### Testing

8. **`verify_rate_limiter.py`** - Enhanced verification
   - Tests player-level rate limiting (10 capacity)
   - Tests connection-level rate limiting (20 capacity)
   - Simulates shared-WiFi scenario (6 friends joining)
   - Note about atomicity testing requiring integration tests

## Rate Limiting Strategy

| Phase | Key | Capacity | Refill Rate | Purpose |
|-------|-----|----------|-------------|---------|
| Pre-join | `rate_limit:conn:{client_ip}` | 20 | 10/sec | Allow legitimate multi-player joins on shared WiFi |
| Post-join | `rate_limit:{player_id}` | 10 | 5/sec | Prevent message-spam per player |

## Architecture Consistency

This fix makes the architecture story consistent:

- **Game state coordination:** Atomic via distributed lock in `room_store.py`
- **Rate limiting coordination:** Atomic via Lua script in `rate_limiter.py`
- **Both:** Use Sentinel for HA, `retry_with_backoff` for transient errors, WideEvent for logging

No "we prevent races for X but not Y" inconsistencies in interview discussions.

## Running the Stack

```bash
# Build and start all services
docker-compose up --build

# Access application
http://localhost:8080/health

# WebSocket endpoint
ws://localhost:8080/ws/{room_id}

# Test failover (kill primary, watch Sentinel promote replica)
docker-compose kill redis-primary
# App instances automatically discover new primary via Sentinel

# View logs for rate limiting
docker-compose logs -f app1 app2 | grep rate_limited
```

## Testing Notes

- Unit tests: `python3 verify_rate_limiter.py` (requires local Redis)
- Integration tests: Full docker-compose stack required
- Race condition tests: Need concurrent load (multiple clients hitting app1/app2 simultaneously)
- Failover tests: Kill redis-primary mid-game, verify rate limiter survives via retry

## Trade-offs Documented

1. **Connection rate limit capacity (20)**: High enough for legitimate shared-WiFi scenarios, low enough to block true floods. Malicious actor sustaining 10 req/sec triggers other observable DoS signals.

2. **Proxy header wildcard**: `--forwarded-allow-ips=*` acceptable in compose network (nginx is sole source). Production should scope to actual LB IP range.

3. **Single round trip**: Lua script is more efficient than GET+SET (one Redis call instead of two).

## Contract Compliance

✅ Extended existing patterns (retry, Sentinel, WideEvent) without reinventing  
✅ No changes to `models.py` fields  
✅ Owns `game_engine/*.py`, `docker-compose.yml`, `nginx/`, `redis/`  
✅ Atomic coordination matches room lock pattern  
✅ Rate-limited events logged to WideEvent, not separate log lines
