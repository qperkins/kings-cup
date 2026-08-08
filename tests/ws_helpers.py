"""Async websocket helpers connecting to in-process uvicorn server."""
from __future__ import annotations

import asyncio
import json
import threading
import time
from contextlib import contextmanager
from typing import Iterator
from uuid import uuid4

import pytest
import uvicorn
import websockets

from game_engine.main import app


@contextmanager
def live_server(host: str = "127.0.0.1", port: int = 8765) -> Iterator[str]:
    config = uvicorn.Config(app, host=host, port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 5
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.05)
    if not server.started:
        raise RuntimeError("uvicorn server failed to start")
    try:
        yield f"ws://{host}:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=5)


@pytest.fixture
def ws_server(patch_redis, local_broadcast) -> Iterator[str]:
    with live_server() as url:
        yield url


async def recv_until(ws, predicate, timeout_s: float = 2.0):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        msg = json.loads(await ws.recv())
        if predicate(msg):
            return msg
    raise AssertionError("Timed out waiting for expected websocket message")


async def recv_all_pending(ws, timeout_s: float = 0.3) -> list[dict]:
    messages: list[dict] = []
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=0.05))
            messages.append(msg)
        except Exception:
            break
    return messages


async def join_and_sync(ws, name: str, *, resume_token: str | None = None) -> tuple[dict, str]:
    payload = {
        "type": "join",
        "action_id": str(uuid4()),
        "player_name": name,
    }
    if resume_token:
        payload["resume_token"] = resume_token
    await ws.send(json.dumps(payload))
    sync = await recv_until(ws, lambda m: m.get("type") == "state_sync")
    return sync, sync["payload"]["your_player_id"]
