"""Shared test helpers."""
from __future__ import annotations

import json
from contextlib import ExitStack
from typing import Any

from starlette.testclient import TestClient

from game_engine.main import app


def parse_wide_events(captured: str) -> list[dict[str, Any]]:
    """Parse JSON wide-event lines emitted to stdout by WideEvent."""
    events: list[dict[str, Any]] = []
    for line in captured.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and "event" in parsed:
            events.append(parsed)
    return events


def wide_events_named(captured: str, name: str) -> list[dict[str, Any]]:
    return [e for e in parse_wide_events(captured) if e.get("event") == name]


def websocket_sessions(*room_paths: str):
    """Open multiple websockets on one TestClient (requires local_broadcast fixture)."""
    stack = ExitStack()
    client = stack.enter_context(TestClient(app))
    sessions = [stack.enter_context(client.websocket_connect(path)) for path in room_paths]
    return stack, sessions
