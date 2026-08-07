"""
Entry point. Keeps transport concerns (WebSocket, JSON parsing, error
mapping) separate from game rules (engine.py), state storage/locking
(room_store.py), and connection fan-out (connection_manager.py) -- each
piece is independently testable and independently swappable.

Every message processed emits exactly one wide event (see logging_utils.py)
rather than several scattered log lines -- see WideEvent usage below.
"""
from __future__ import annotations

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from .connection_manager import ConnectionManager
from .engine import EngineError, EngineResult, apply_intent
from .logging_utils import WideEvent, timed_field
from .models import ActionIntent, JoinIntent, ServerEvent
from .rate_limiter import check_connection_rate_limit, check_rate_limit
from .redis_client import get_master
from .retry import RetriesExhausted
from .room_store import apply_with_lock

app = FastAPI(title="King's Cup Game Engine")
manager = ConnectionManager()

_intent_adapter: TypeAdapter[ActionIntent] = TypeAdapter(ActionIntent)


@app.get("/health")
async def health() -> dict:
    with WideEvent("health_check") as event:
        redis = get_master()
        try:
            await redis.ping()
            event["redis_ok"] = True
        except Exception as exc:
            event["redis_ok"] = False
            event["error"] = {"type": type(exc).__name__, "message": str(exc)}
        event["outcome"] = "success" if event.fields.get("redis_ok") else "degraded"
        return {"status": "ok" if event.fields.get("redis_ok") else "degraded", "redis": event.fields.get("redis_ok")}


@app.websocket("/ws/{room_id}")
async def room_socket(websocket: WebSocket, room_id: str):
    player_id: str | None = None

    try:
        while True:
            raw = await websocket.receive_json()

            with WideEvent("message_processed", room_id=room_id) as event:
                # Pre-join rate limiting: check by connection IP before player_id exists.
                # This prevents join-spam DoS where an attacker floods join requests
                # before successfully joining (each join acquires a room lock).
                if player_id is None:
                    conn_allowed = await check_connection_rate_limit(websocket)
                    event["connection_rate_limited"] = not conn_allowed
                    if not conn_allowed:
                        event["outcome"] = "connection_rate_limited"
                        await websocket.send_json(
                            ServerEvent(type="error", payload={"detail": "Too many requests, slow down"}).model_dump()
                        )
                        continue

                try:
                    intent = _intent_adapter.validate_python(raw)
                except ValidationError as exc:
                    event.update(outcome="invalid_message", error={"type": "ValidationError", "message": str(exc)})
                    await websocket.send_json(
                        ServerEvent(type="error", payload={"detail": str(exc)}).model_dump()
                    )
                    continue

                event["intent_type"] = intent.type
                event["action_id"] = intent.action_id

                if isinstance(intent, JoinIntent) and player_id is None:
                    event["is_join"] = True
                    try:
                        with timed_field(event, "lock_wait"):
                            result = await apply_with_lock(room_id, lambda state: apply_intent(state, intent))
                    except EngineError as exc:
                        event.update(outcome="rejected", error={"type": "EngineError", "message": str(exc)})
                        await websocket.send_json(
                            ServerEvent(type="error", payload={"detail": str(exc)}).model_dump()
                        )
                        continue
                    except RetriesExhausted as exc:
                        event.update(outcome="lock_timeout", error={"type": "RetriesExhausted", "message": str(exc)})
                        await websocket.send_json(
                            ServerEvent(type="error", payload={"detail": "Room busy, please retry"}).model_dump()
                        )
                        continue

                    player_id = result.events[-1].payload.get("id") if result.events else None
                    event["player_id"] = player_id
                    if player_id:
                        await manager.connect(room_id, player_id, websocket)
                        # Broadcast roster update to all clients
                        for e in result.events:
                            await manager.publish(room_id, e)
                        
                        # Send full state to this specific client for self-identification
                        # Includes your_player_id so client knows which player in the roster is them
                        payload = result.state.to_client_view()
                        payload["your_player_id"] = player_id
                        await manager.send_to(
                            room_id, 
                            player_id,
                            ServerEvent(type="state_sync", payload=payload)
                        )
                    event["outcome"] = "success"
                    continue

                event["player_id"] = player_id

                # Rate limit check for all messages after initial join
                if player_id is not None:
                    allowed = await check_rate_limit(player_id)
                    event["rate_limited"] = not allowed
                    if not allowed:
                        event["outcome"] = "rate_limited"
                        await websocket.send_json(
                            ServerEvent(type="error", payload={"detail": "Rate limit exceeded, slow down"}).model_dump()
                        )
                        continue

                try:
                    with timed_field(event, "lock_wait"):
                        result = await apply_with_lock(room_id, lambda state: apply_intent(state, intent))
                except EngineError as exc:
                    event.update(outcome="rejected", error={"type": "EngineError", "message": str(exc)})
                    await websocket.send_json(
                        ServerEvent(type="error", payload={"detail": str(exc)}).model_dump()
                    )
                    continue
                except RetriesExhausted as exc:
                    # Lock never freed up in time -- surfaced as retryable to
                    # the client. Safe to retry because every intent carries
                    # an action_id the engine dedupes on.
                    event.update(outcome="lock_timeout", error={"type": "RetriesExhausted", "message": str(exc)})
                    await websocket.send_json(
                        ServerEvent(type="error", payload={"detail": "Room busy, please retry"}).model_dump()
                    )
                    continue

                for e in result.events:
                    await manager.publish(room_id, e)
                event["events_emitted"] = [e.type for e in result.events]
                event["outcome"] = "success"

    except WebSocketDisconnect:
        with WideEvent("player_disconnected", room_id=room_id, player_id=player_id) as event:
            if player_id:
                manager.disconnect(room_id, player_id)

                def _mark_disconnected(state):
                    for p in state.players:
                        if p.id == player_id:
                            p.connected = False
                    return EngineResult(state=state, events=[])

                try:
                    with timed_field(event, "lock_wait"):
                        await apply_with_lock(room_id, _mark_disconnected)
                    event["outcome"] = "success"
                except RetriesExhausted as exc:
                    event.update(outcome="lock_timeout", error={"type": "RetriesExhausted", "message": str(exc)})
