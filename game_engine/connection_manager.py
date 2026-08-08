"""
Tracks local WebSocket connections and fans events out across every app
instance via Redis pub/sub, so a broadcast triggered by an action processed
on instance A reaches a client connected to instance B.

The mechanism: instances don't broadcast() to their own local sockets
directly. They publish() to a per-room Redis channel. Every instance that
has at least one local connection to that room is subscribed to the same
channel, so all of them (including the publisher) receive the message and
forward it to their own local sockets. This means "publish" and "deliver
to local sockets" are decoupled -- which is the actual distributed-systems
property here: no instance needs to know which other instances hold
connections for a room, Redis pub/sub handles that discovery for free.
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import WebSocket

from .models import ServerEvent
from .redis_client import get_master, get_replica
from .retry import retry_with_backoff
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError

logger = logging.getLogger("kings_cup.connections")

_TRANSIENT_REDIS_ERRORS = (RedisConnectionError, RedisTimeoutError)


def _channel(room_id: str) -> str:
    return f"room:{room_id}:events"


class ConnectionManager:
    def __init__(self) -> None:
        # room_id -> {player_id: WebSocket}  (local to this instance only)
        self._rooms: dict[str, dict[str, WebSocket]] = {}
        # room_id -> background task listening on that room's Redis channel
        self._subscriptions: dict[str, asyncio.Task] = {}

    async def connect(self, room_id: str, player_id: str, ws: WebSocket) -> None:
        is_first_local_connection = room_id not in self._rooms or not self._rooms[room_id]
        self._rooms.setdefault(room_id, {})[player_id] = ws

        if is_first_local_connection:
            self._subscriptions[room_id] = asyncio.create_task(self._listen(room_id))

    def disconnect(self, room_id: str, player_id: str) -> None:
        room = self._rooms.get(room_id)
        if room and player_id in room:
            del room[player_id]

        if room is not None and not room:
            del self._rooms[room_id]
            task = self._subscriptions.pop(room_id, None)
            if task:
                task.cancel()

    async def publish(self, room_id: str, event: ServerEvent) -> None:
        """Call this instead of pushing to sockets directly. Every instance
        with local listeners for this room -- including this one, if it has
        any -- will receive it via the subscription and deliver it locally.

        Wrapped in backoff+jitter: a publish landing during the ~1-2s window
        of a Sentinel failover would otherwise surface as a hard connection
        error and drop the event on the floor. Retrying gives the client
        discovery time to find the newly-promoted master."""
        async def _op():
            redis = get_master()
            receivers = await redis.publish(_channel(room_id), event.model_dump_json())
            logger.info(json.dumps({"event": "pub_broadcast", "room_id": room_id, "event_type": event.type, "receivers": receivers}))

        await retry_with_backoff(_op, max_attempts=4, retryable_exceptions=_TRANSIENT_REDIS_ERRORS)

    async def send_to(self, room_id: str, player_id: str, event: ServerEvent) -> None:
        """Direct-to-one-client send (e.g. validation errors) -- doesn't need
        to go through Redis since it only ever needs to reach a socket that,
        if connected at all, must be connected to *this* instance (the one
        that received the WebSocket message from them)."""
        ws = self._rooms.get(room_id, {}).get(player_id)
        if ws is not None:
            await ws.send_json(event.model_dump())

    def connected_count(self, room_id: str) -> int:
        return len(self._rooms.get(room_id, {}))

    async def _listen(self, room_id: str) -> None:
        """Background task: subscribe to this room's channel on a replica
        (spreads pub/sub fan-out load off the primary) and forward every
        message to this instance's local sockets for the room."""
        redis = get_replica()
        pubsub = redis.pubsub()
        await pubsub.subscribe(_channel(room_id))
        try:
            async for message in pubsub.listen():
                if message["type"] != "message":
                    continue
                event = ServerEvent.model_validate(json.loads(message["data"]))
                await self._deliver_local(room_id, event)
        except asyncio.CancelledError:
            pass
        finally:
            await pubsub.unsubscribe(_channel(room_id))
            await pubsub.aclose()

    async def _deliver_local(self, room_id: str, event: ServerEvent) -> None:
        room = self._rooms.get(room_id, {})
        stale: list[str] = []
        delivered = 0
        for player_id, ws in room.items():
            try:
                await ws.send_json(event.model_dump())
                delivered += 1
            except Exception:
                stale.append(player_id)
        logger.info(json.dumps({"event": "pub_deliver", "room_id": room_id, "event_type": event.type, "delivered": delivered, "stale": len(stale)}))
        for player_id in stale:
            self.disconnect(room_id, player_id)
