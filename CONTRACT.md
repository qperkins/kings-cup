# Build Contract — King's Cup Distributed Game Engine

Read this before writing any code. Every agent below builds against the
same frozen contract so integration doesn't turn into a debugging session
on day 3. If you need to change something in this contract, stop and flag
it to the human orchestrator — don't silently diverge.

## Source of truth

- Data shapes: `game_engine/models.py` (Card, Player, GameState,
  ActionIntent union, ServerEvent)
- Game rules: `game_engine/engine.py` (pure functions, no I/O — this is
  already written; extend it, don't fight it)
- Wire protocol: every message client→server is one of the `ActionIntent`
  variants (`join`, `start_game`, `draw_card`) as JSON with a `type` field.
  Every message server→client is a `ServerEvent` with a `type` and
  `payload`. New event/intent types are additive — don't rename existing
  fields without updating this doc.
- Backend package is named `game_engine`, deliberately not `app` — the
  Next.js repo root already has an `app/` directory (App Router). Don't
  reintroduce the collision.

## Three coding conventions — mandatory for every agent, every file

These apply everywhere, backend and frontend, not just in the reference
files. If you're writing a try/catch, a network call, or a log line and
you didn't reach for one of these, stop and check why.

**1. Retries: full-jitter exponential backoff, never a fixed retry loop.**
Backend: `game_engine/retry.py` — `retry_with_backoff(operation, ...)`.
Frontend: `@kings-cup/shared`'s `retryWithBackoff`. Used for anything
that talks to Redis, and for WS reconnects/resends. Pick retryable
exceptions deliberately — connection/timeout errors are retryable,
business-logic rejections (`EngineError`) are not, because retrying an
illegal action just repeats the same rejection.

**2. Logging: one wide event per unit of work, not scattered log lines.**
Backend: `game_engine/logging_utils.py`'s `WideEvent` — one per WS message
processed, enriched with every field that might matter (room_id,
player_id, intent_type, lock_wait_ms, outcome, error), emitted once.
Frontend: `@kings-cup/shared`'s `WideEvent` — one per action sent. Never
add a bare `console.log`/`logger.info` mid-function as a "just checking"
line — if it's worth logging, it's worth being a field on the current
wide event.

**3. Error handling in TypeScript: `tryCatch`, never a bare try/catch.**
`@kings-cup/shared`'s `tryCatch`/`tryCatchSync`. Every fallible async
call returns `{ success: true, data } | { success: false, error: unknown }`
— callers narrow via `result.success`, then narrow `error` with
`instanceof` before handling it. No `catch (e: any)`, no unchecked casts
on the error. See `gameSocket.ts` for the pattern applied end to end.
(Python doesn't need an equivalent for this one — Python's typed
exceptions + the existing `EngineError`/`RetriesExhausted` hierarchy
already give the same narrowing story on that side.)

## Non-negotiable architectural decisions (don't relitigate these per-agent)

1. **Server-authoritative.** Clients send intent, server decides outcome.
   No client ever sends "I drew a King" — it sends `draw_card` and waits
   for the `card_drawn` event.
2. **Idempotency.** Every intent carries an `action_id`. Replays of the
   same `action_id` are no-ops (see `engine.apply_intent`). Frontend must
   generate a fresh UUID per user action, and may safely retry a timed-out
   request with the *same* `action_id` — this is also what makes retry
   convention #1 above safe to apply to sends, not just reconnects.
3. **State lives in Redis, not in process memory.** Never add a
   module-level `dict` holding game state in any new backend code — go
   through `room_store.apply_with_lock`.
4. **Reconnect uses `resume_token` = player's existing `id`.** The
   frontend must persist the player's id (`GameSocket.saveResumeToken` /
   `getResumeToken` in the shared package) and send it as `resume_token`
   on the next `join` after a dropped connection.

---

## Agent 1 — Backend

Owns: `game_engine/*.py`, `docker-compose.yml`, `redis/`, `nginx/`.

Scope for this pass:
- Sentinel wiring, backoff+jitter, and wide-event logging are already
  done — verify them, extend them, don't rebuild them
- Add rate limiting: per-connection message rate cap (simple token bucket
  in Redis, keyed by player_id, is enough — don't over-engineer). Wrap
  the Redis calls in `retry_with_backoff` like everything else touching
  Redis in this codebase.
- Do NOT change `models.py`'s existing fields without flagging it — the
  frontend and test agents are building against it in parallel

## Agent 2 — Frontend

Owns: `apps/web` (Next.js, reusing existing UI), later `apps/mobile`, and
consumes `@kings-cup/shared` (`packages/shared/` once added to your
`pnpm-workspace.yaml`) for the WS client, tryCatch, retry, and logger.

Scope for this pass:
- Use `GameSocket` from `@kings-cup/shared` as-is rather than writing a
  new WS wrapper — it already implements the retry/logging/tryCatch
  conventions end to end (see `gameSocket.ts`)
## Decommissioning Convex — read this before Agent 2 starts

The existing repo currently runs on Convex for all game/room state. Per
the architecture decision made for this project, Convex is being **fully
replaced** by `game_engine` + Redis — this is not a hybrid, and it is not
"migrate some components and leave others." A repo that ends up with both
Convex and the new WS backend independently managing game state is worse
than either alone: two sources of truth silently contradicts the
"server-authoritative, single source of truth" claim this whole project
exists to demonstrate, and it will not survive five minutes of interview
scrutiny.

Full surface area to remove, not just the obvious hooks:
- `convex/` directory — schema and functions
- Any `ConvexProvider`/`ConvexReactClient` wrapper (commonly in a root
  layout or a `providers.tsx`)
- `useQuery`/`useMutation`/`useConvex` calls in components — find with
  `grep -rn "convex/react\|useQuery\|useMutation\|useConvex" apps/web`
- `convex` and `convex/react` (or similar) entries in `package.json`
- Convex env vars (typically `NEXT_PUBLIC_CONVEX_URL` or similar) in
  `.env.local` / `.env.example`
- The `convex dev` script in `package.json`, if present
- Any Convex deployment config

Order of operations: get the new `GameSocket`-based data flow working end
to end FIRST, verify it in the browser, THEN remove the Convex wiring —
don't rip Convex out before its replacement is proven, or you'll spend
day 2 debugging a blank screen with no working fallback. Once removed,
grep again for `convex` (case-insensitive) across the repo as a final
check — a stray import left behind is an easy thing to miss and an easy
thing for an interviewer to notice.

If any piece of this surface area isn't obviously game-related (e.g. a
Convex table storing something unrelated to rooms/players), stop and flag
it rather than deleting it — don't assume everything under `convex/` is
in scope just because most of it is.

- Persist `player_id` via `GameSocket.saveResumeToken` and read it back
  via `getResumeToken` on reconnect (page reload, dropped WS, app
  backgrounded)
- Do NOT invent new event/intent shapes without checking `models.py` first
  — if the UI needs data the backend doesn't send yet, flag it rather than
  guessing the field name

## Agent 3 — Tests

Owns: `tests/`.

Scope for this pass:
- Unit tests for `game_engine/engine.py` — pure functions, no mocking
  needed. Cover: turn-order enforcement rejects out-of-turn draws,
  duplicate `action_id` is a no-op, reconnect via `resume_token` rejoins
  the same seat rather than creating a new player, King-count-4 ends the
  game
- Unit tests for `game_engine/retry.py` — assert full-jitter delays stay
  within `[0, min(cap, base * 2^attempt))`, and that a non-retryable
  exception is NOT retried (this is the bug class most likely to slip in:
  someone widening `retryable_exceptions` to catch everything, which would
  retry `EngineError` rejections and mask real bugs as "just flaky")
- Integration test: spin up the FastAPI app + a single Redis (testcontainers
  or docker-compose in CI) and drive a full join→start→draw sequence over
  a real WebSocket client
- Failover test (the one that matters for the interview story): start
  the full Sentinel stack, begin a game, kill `redis-primary` mid-game,
  assert the next action either succeeds against the newly-promoted
  primary (via the retry+backoff path) or fails cleanly and succeeds on
  client retry — never silently loses or duplicates a card draw
- Assert wide events are actually emitted with the expected fields on at
  least one happy-path and one error-path test — a WideEvent that never
  fires is worse than no logging convention at all, because it looks
  observable and isn't

## Agent 4 — Runner / Fixer

Owns: nothing new — executes Agent 3's suite against Agent 1 & 2's code,
iterates on failures.

Ground rule: when a test fails, fix the *root cause* in the backend/
frontend code, not the test's assertions, unless the test itself is
provably wrong against this contract. Any fix that touches
`engine.py`'s turn-order or idempotency logic, or `retry.py`'s exception
classification, gets flagged for the human to review before merging —
those are the parts where a "quick fix" can quietly break the property
the whole project is trying to demonstrate.

---

## Merge checklist (human review, not agent-automated)

- [ ] Diff on `engine.py` reviewed line-by-line if touched at all
- [ ] `docker-compose up`, kill `redis-primary`, confirm failover + game
      continuity manually at least once — watch the wide-event logs during
      the outage window, confirm `lock_wait_ms`/retry fields show up as
      expected rather than the request just silently hanging
- [ ] `/health` returns `degraded` (not a crash) if Redis is unreachable
- [ ] k6 WS load test run, numbers recorded in README
