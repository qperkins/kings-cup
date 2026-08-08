# King's Cup

An open-source King's Cup drinking game for the web — live at **[kxc.cards](https://kxc.cards)** (`wss://kxc.cards`).

I built a Next.js frontend and a FastAPI game engine backend that talk over WebSocket. The interesting part isn't the card rules — it's everything around keeping a room in sync when connections drop, phones lock, and six people share one WiFi router.

The target audience makes that pressure real. People playing at a party have almost no patience for a clunky, slow experience — they'll drop the app and go back to real cards before the round finishes. A smooth, fast feel wasn't something I could polish in at the end; it had to be built into the architecture from the start.

---

## Why I Chose This Project

I chose this project because it mirrors problems major companies have to solve in real-time multiplayer. King's Cup is a game where multiple users connect to a specific room and expect a fast, low-latency experience. Most of them are on mobile, and they disconnect constantly — screen saver kicks in, they switch apps, WiFi hiccups. I wanted something I could point to that shows how I'd handle client *and* server-side disconnects without treating them as edge cases.

A whole table playing in person often shares one public IP. That turned out to matter more than I expected when I added rate limiting.

---

## What I Built

I split the project into a Next.js frontend and a Python game engine (`game_engine`) behind Nginx.

| Layer | Stack | What it does |
|---|---|---|
| Frontend | Next.js, Tailwind, shadcn/ui, Motion | Room UI; WebSocket client via `@kings-cup/shared` |
| Backend | FastAPI, Redis, Nginx | Authoritative game state, pub/sub fan-out, SSL |
| Dev | Redis Sentinel, 2 app instances ([`docker-compose.yml`](docker-compose.yml)) | Failover and retry testing |
| Prod | Single Redis, 1 app ([`docker-compose.prod.yml`](docker-compose.prod.yml)) | Oracle Cloud free tier at kxc.cards |

Wire protocol, idempotency rules, and coding conventions live in [`CONTRACT.md`](CONTRACT.md). CI/CD and production setup are in [`DEPLOYMENT.md`](DEPLOYMENT.md).

---

## Design Choices I Made (and What I Gave Up)

### I prioritized availability over raw scalability

For this scope, I cared more about surviving failure than optimizing for millions of users on day one. In dev I run Redis Sentinel with two app instances behind Nginx so I can actually test failover — kill the primary, draw a card, see if retries hold up. Production on Oracle is deliberately simpler: one Redis, one app. I traded HA complexity for a free tier I can afford to leave running. The retry layer still handles transient Redis blips, but a hard Redis outage in prod would hurt until I promote Sentinel there too.

### I kept game rules server-side

Clients send intent (`join`, `start_game`, `draw_card`) with an `action_id`; the server decides the outcome in [`game_engine/engine.py`](game_engine/engine.py). I did it this way so no client can cheat and so retries are safe — replays of the same `action_id` are no-ops. State lives in Redis under per-room locks ([`room_store.py`](game_engine/room_store.py)), not in process memory, so any app instance can handle any room.

### I built reconnect around `resume_token`

Mobile disconnect is normal, not exceptional. I persist the player's id client-side and send it back as `resume_token` on the next join. The server responds with a targeted `state_sync` that includes `your_player_id`, so you immediately know which seat is yours mid-game. Broadcast events alone weren't enough — every client sees `player_joined` for everyone else too.

### I used Redis pub/sub for cross-instance fan-out

When I run multiple app instances, an action processed on instance A has to reach a client connected to instance B. I publish room events to a Redis channel; every instance subscribed to that room forwards to its local WebSockets ([`connection_manager.py`](game_engine/connection_manager.py)). Adding more app replicas behind Nginx is mostly an ops change — the code path already supports it.

### I wrapped Redis ops in backoff with jitter

Sentinel failover creates windows where Redis calls fail transiently. I wrapped locks, saves, and pub/sub in full-jitter exponential backoff ([`retry.py`](game_engine/retry.py)) so those blips don't duplicate game actions or lose state. The frontend mirrors the same pattern in `@kings-cup/shared` for WebSocket resends.

### I tuned rate limits so shared WiFi doesn't lock out a table

I hit a real problem early: six friends on one WiFi look like one IP to the server. A strict pre-join connection limit blocked legitimate joins.

I use two token buckets in [`rate_limiter.py`](game_engine/rate_limiter.py):

- **Per-player** (after join): 10-token burst, 5 tokens/sec refill — stops spam without affecting other players in the room.
- **Pre-join by IP**: 20-token burst, 10 tokens/sec refill — more generous because a table of friends tapping "Join" within a second or two is a normal Tuesday, not an attack.

What I gave up: someone on the same IP could still spam joins until the bucket drains. Fixing that properly would need per-device identity, which I didn't scope here.

### I use different Redis wiring in dev vs prod

In dev I go through Sentinel (`SENTINEL_HOSTS`). In prod I set `REDIS_DIRECT_URL` and connect straight to a single Redis instance ([`redis_client.py`](game_engine/redis_client.py)). Same codebase, different env — no second code path beyond the connection factory.

---

## What I'd Do Next

**What this can actually handle today:** I want to be honest about the numbers. "100k users" was aspirational — the code doesn't support that on what's running in prod right now.

On the current Oracle setup (1 OCPU, single uvicorn process, single Redis), I'd expect roughly **500–2,000 concurrent WebSocket connections** before memory, CPU, or Redis pub/sub pressure shows up in latency. That's on the order of **~100–400 active game rooms** at typical party sizes (4–8 players). The architecture is room-based and lightweight per connection, but everything still flows through one app instance and one Redis primary — that's the ceiling.

**What the code is actually built to scale toward:** The pub/sub fan-out and per-room locking in [`connection_manager.py`](game_engine/connection_manager.py) and [`room_store.py`](game_engine/room_store.py) mean I could add more app replicas behind Nginx without rewriting the game logic. If I moved to a larger Redis instance and ran several app instances, I'd estimate **~5,000–15,000 concurrent connections** before Redis itself becomes the bottleneck — still not 100k, but a real step up from where prod sits today.

**What 100k concurrent would actually require:** Global room partitioning / sharding — routing `room_id` to regional Redis clusters — plus many app instances per region. That's out of scope for this project. I also skipped a full observability pipeline; WideEvent structured logs plus `docker compose logs` are enough for me right now.

**On my list:**

- Client-side stale-state detection and resync (there's a TODO in [`main.py`](game_engine/main.py) for when pub/sub fails mid-failover)
- Automated frontend E2E in CI — I have a manual workflow that smoke-tests `wss://kxc.cards` today
- Promote Sentinel + multiple app instances to production if I outgrow the single-node ceiling

---

## Tech Stack

- **Frontend:** Next.js (App Router), Tailwind CSS, shadcn/ui, Motion
- **Shared client:** `@kings-cup/shared` — `GameSocket`, retry, wide-event logging
- **Backend:** FastAPI (`game_engine`), Redis, Nginx
- **Testing:** pytest (backend), Vitest (frontend)
- **CI/CD:** GitHub Actions → GHCR (ARM64) → Oracle Cloud
- **Package manager:** pnpm

---

## Local Development

**Backend** (Sentinel dev stack):

```bash
docker compose up
# Nginx entry point: ws://localhost:8080
```

**Frontend:**

```bash
pnpm install
pnpm dev
# NEXT_PUBLIC_WS_URL=ws://localhost:8080
```

Open `http://localhost:3000`.

**Backend tests** (needs Redis on port 6379, or use the compose stack):

```bash
pip install -r requirements.txt -r requirements-dev.txt
pytest tests/ -v
```

Verification scripts: `scripts/verification/`.

---

## CI/CD

I deploy to kxc.cards on Oracle's free ARM tier.

- **Test** — every push/PR; pytest with a Redis service
- **Deploy** — push to `main`; ARM64 build → public GHCR image → SSH deploy
- **E2E** — manual workflow; WebSocket smoke against production

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for Oracle setup, GHCR visibility, and troubleshooting.
