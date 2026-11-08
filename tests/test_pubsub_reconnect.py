"""The pub/sub listener must survive its Redis node dying (Sentinel failover)."""
import asyncio
import json

import pytest

from game_engine import connection_manager as cm
from game_engine.models import GameState, Player, ServerEvent


class FakeWS:
    def __init__(self):
        self.sent = []

    async def send_json(self, data):
        self.sent.append(data)


class FakePubSub:
    def __init__(self, script):
        self.script = script  # "die" or a list of messages

    async def subscribe(self, *_):
        pass

    async def unsubscribe(self, *_):
        pass

    async def aclose(self):
        pass

    async def listen(self):
        if self.script == "die":
            raise ConnectionError("node went away")
        for m in self.script:
            yield {"type": "message", "data": m}
        await asyncio.sleep(3600)


class FakeRedis:
    def __init__(self, scripts):
        self.scripts = scripts

    def pubsub(self):
        return FakePubSub(self.scripts.pop(0))


@pytest.mark.asyncio
async def test_listener_resubscribes_and_resyncs_after_node_loss(monkeypatch):
    evt = ServerEvent(type="turn_advanced", payload={"current_turn_seat": 1}).model_dump_json()
    redis = FakeRedis(["die", [evt]])
    monkeypatch.setattr(cm, "get_replica", lambda: redis)

    state = GameState(room_id="r")
    state.players.append(Player(id="p1", name="A", seat=0))

    async def fake_load(room_id):
        return state

    monkeypatch.setattr("game_engine.room_store.load_state", fake_load)

    mgr = cm.ConnectionManager()
    ws = FakeWS()
    await mgr.connect("r", "p1", ws)
    for _ in range(100):
        if any(m["type"] == "turn_advanced" for m in ws.sent):
            break
        await asyncio.sleep(0.05)
    types = [m["type"] for m in ws.sent]
    assert "state_sync" in types, types  # resync after the outage
    assert "turn_advanced" in types, types  # live events flow again
    assert ws.sent[0]["payload"]["your_player_id"] == "p1"
    mgr.disconnect("r", "p1")
