"""
Wide events / canonical log lines, per https://loggingsucks.com/.

The failure mode this avoids: a "join" then a "draw_card" then a
"turn_advanced" broadcast each getting their own scattered log.info() call
means debugging "why did player X get rejected" requires grepping 4-5 lines
across a request and manually stitching them back together by request_id.

Instead: build ONE event object as the message flows through the handler,
attach every field that might matter (room, player, intent type, lock wait
time, retry counts, outcome, error detail), and emit it exactly once when
the message is fully processed. One line, all the context, queryable
after the fact -- e.g. "show me every draw_card in room X where
lock_wait_ms > 100" is a single filter over structured fields, not a
string search across a stream of unrelated log lines.
"""
from __future__ import annotations

import json
import logging
import sys
import time
from contextlib import contextmanager
from typing import Any

_logger = logging.getLogger("kings_cup.wide_events")
_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(logging.Formatter("%(message)s"))  # raw JSON, no prefix noise
_logger.addHandler(_handler)
_logger.setLevel(logging.INFO)
_logger.propagate = False


class WideEvent:
    """Accumulates fields for one unit of work (one WS message processed),
    then emits a single structured JSON line on exit. Enrich it as you go:

        with WideEvent("message_processed", room_id=room_id) as event:
            event["intent_type"] = intent.type
            ...
            event["outcome"] = "success"
    """

    def __init__(self, event_name: str, **initial: Any):
        self._start = time.monotonic()
        self.fields: dict[str, Any] = {"event": event_name, **initial}

    def __setitem__(self, key: str, value: Any) -> None:
        self.fields[key] = value

    def update(self, **kwargs: Any) -> None:
        self.fields.update(kwargs)

    def __enter__(self) -> "WideEvent":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        self.fields["duration_ms"] = round((time.monotonic() - self._start) * 1000, 2)

        if exc is not None:
            # An unhandled exception still gets recorded as part of the same
            # wide event rather than a separate, disconnected error log --
            # outcome and error detail live on the one line together.
            self.fields.setdefault("outcome", "error")
            self.fields["error"] = {"type": type(exc).__name__, "message": str(exc)}

        _logger.info(json.dumps(self.fields, default=str))
        return False  # don't suppress the exception


@contextmanager
def timed_field(event: WideEvent, field_name: str):
    """Convenience for timing a sub-step (e.g. lock acquisition) and
    attaching it to the wide event as `<field_name>_ms`, instead of a
    separate log line just to report a duration."""
    start = time.monotonic()
    try:
        yield
    finally:
        event[f"{field_name}_ms"] = round((time.monotonic() - start) * 1000, 2)
