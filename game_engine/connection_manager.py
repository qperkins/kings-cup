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
from .logging_utils import WideEvent
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import ReadOnlyError as RedisReadOnlyError
from redis.exceptions import TimeoutError as RedisTimeoutError

logger = logging.getLogger("kings_cup.connections")

# ReadOnlyError: the node we reached was demoted to replica by a failover; the
# next get_master() resolves the new primary, so it is retryable like a dropped link.
_TRANSIENT_REDIS_ERRORS = (RedisConnectionError, RedisTimeoutError, RedisReadOnlyError)


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

    def disconnect(self, room_id: str, player_id: str, ws: WebSocket | None = None) -> None:
        """Drop a player's local socket. When `ws` is given, only drop it if it is
        still the registered socket, so an old connection closing can't evict the
        newer connection that replaced it (same player, second tab/reconnect)."""
        room = self._rooms.get(room_id)
        if room and player_id in room and (ws is None or room[player_id] is ws):
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
        with WideEvent("pub_broadcast", room_id=room_id, event_type=event.type) as log:
            async def _op():
                redis = get_master()
                receivers = await redis.publish(_channel(room_id), event.model_dump_json())
                log["receivers"] = receivers
                log["outcome"] = "success"

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
        message to this instance's local sockets for the room.

        A subscription is bound to one Redis node. If that node dies (Sentinel
        failover, restart, network blip) the stream ends or raises; without a
        reconnect every client on this instance would silently stop receiving
        room events while its own actions still succeed. So we loop: resubscribe
        through Sentinel with backoff, then push each local player a fresh
        state_sync to cover whatever was published while we were deaf."""
        channel = _channel(room_id)
        delay = 0.2
        first = True
        try:
            while room_id in self._rooms:
                pubsub = None
                try:
                    pubsub = get_replica().pubsub()
                    await pubsub.subscribe(channel)
                    if not first:
                        logger.warning("pubsub resubscribed room=%s", room_id)
                        await self._resync_local(room_id)
                    first = False
                    delay = 0.2
                    async for message in pubsub.listen():
                        if message["type"] != "message":
                            continue
                        event = ServerEvent.model_validate(json.loads(message["data"]))
                        await self._deliver_local(room_id, event)
                    # listen() returned: the connection was closed under us.
                    logger.warning("pubsub stream ended room=%s; reconnecting", room_id)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # connection lost, failover, bad payload
                    logger.warning("pubsub error room=%s: %r; reconnecting", room_id, exc)
                    first = False
                finally:
                    if pubsub is not None:
                        try:
                            await pubsub.unsubscribe(channel)
                            await pubsub.aclose()
                        except Exception:
                            pass
                await asyncio.sleep(delay)
                delay = min(delay * 2, 5.0)
        except asyncio.CancelledError:
            pass

    async def _resync_local(self, room_id: str) -> None:
        """Send every local socket for the room the current full state."""
        from .room_store import load_state  # local import: avoids a cycle

        try:
            state = await load_state(room_id)
        except Exception as exc:
            logger.warning("resync load failed room=%s: %r", room_id, exc)
            return
        for player_id, ws in list(self._rooms.get(room_id, {}).items()):
            payload = state.to_client_view()
            payload["your_player_id"] = player_id
            try:
                await ws.send_json(ServerEvent(type="state_sync", payload=payload).model_dump())
            except Exception:
                self.disconnect(room_id, player_id, ws)

    async def _deliver_local(self, room_id: str, event: ServerEvent) -> None:
        with WideEvent("pub_deliver", room_id=room_id, event_type=event.type) as log:
            room = self._rooms.get(room_id, {})
            stale: list[str] = []
            delivered = 0
            for player_id, ws in room.items():
                try:
                    await ws.send_json(event.model_dump())
                    delivered += 1
                except Exception:
                    stale.append(player_id)
            log["delivered"] = delivered
            log["stale"] = len(stale)
            log["outcome"] = "success"
            for player_id in stale:
                self.disconnect(room_id, player_id)

            # A kicked player must stop receiving room events and can't be left
            # holding an open socket. Every instance runs this for its own local
            # sockets, so it works across instances without extra coordination.
            # (Players who *leave* are closed by main.py after their ack instead.)
            if event.type == "player_removed" and event.payload.get("reason") == "kicked":
                removed_id = event.payload.get("player_id")
                removed_ws = room.get(removed_id) if removed_id else None
                if removed_ws is not None:
                    self.disconnect(room_id, removed_id, removed_ws)
                    try:
                        await removed_ws.close()
                    except Exception:
                        pass
