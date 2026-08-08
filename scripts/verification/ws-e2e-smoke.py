#!/usr/bin/env python3
"""WS smoke test against game_engine."""
import asyncio
import json
import random
import string
import sys
import uuid

try:
    import websockets
except ImportError:
    print("pip install websockets")
    sys.exit(1)

WS_BASE = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8080"
ROOM = "SMOKE" + "".join(random.choices(string.ascii_uppercase + string.digits, k=4))


async def connect(room_id: str):
    url = f"{WS_BASE}/ws/{room_id}"
    ws = await websockets.connect(url)
    events = []

    async def reader():
        async for raw in ws:
            events.append(json.loads(raw))

    task = asyncio.create_task(reader())
    return ws, events, task


async def join(ws, events, name, resume=None):
    await ws.send(
        json.dumps(
            {
                "type": "join",
                "action_id": str(uuid.uuid4()),
                "player_name": name,
                **({"resume_token": resume} if resume else {}),
            }
        )
    )
    await asyncio.sleep(0.6)


async def main():
    print(f"Room: {ROOM}, WS: {WS_BASE}")

    ws1, ev1, _ = await connect(ROOM)
    await join(ws1, ev1, "Alice")
    sync1 = next((e for e in ev1 if e.get("type") == "state_sync"), None)
    id1 = sync1["payload"]["your_player_id"] if sync1 else None
    print("P1 state_sync:", "yes" if sync1 else "NO", "your_player_id:", id1)
    print("P1 drawn_pile_top:", sync1["payload"].get("drawn_pile_top") if sync1 else None)

    ws2, ev2, _ = await connect(ROOM)
    await join(ws2, ev2, "Bob")
    sync2 = next((e for e in ev2 if e.get("type") == "state_sync"), None)
    print("P2 state_sync:", "yes" if sync2 else "NO", "players:", len(sync2["payload"]["players"]) if sync2 else 0)

    await ws1.send(json.dumps({"type": "start_game", "action_id": str(uuid.uuid4())}))
    await asyncio.sleep(0.6)
    print("game_started:", any(e.get("type") == "game_started" for e in ev1))

    await ws1.send(
        json.dumps({"type": "draw_card", "action_id": str(uuid.uuid4()), "player_id": id1})
    )
    await asyncio.sleep(0.6)
    drawn = next((e for e in ev1 if e.get("type") == "card_drawn"), None)
    if drawn:
        c = drawn["payload"]["card"]
        print("card_drawn:", c["rank"], "of", c["suit"])
    else:
        print("card_drawn: NO")

    await ws1.close()
    await asyncio.sleep(0.3)

    ws1b, ev1b, _ = await connect(ROOM)
    await join(ws1b, ev1b, "Alice", id1)
    await asyncio.sleep(0.6)
    resync = next((e for e in ev1b if e.get("type") == "state_sync"), None)
    if resync:
        p = resync["payload"]
        print("Reconnect phase:", p.get("phase"))
        print("Reconnect cards_remaining:", p.get("cards_remaining"))
        print("Reconnect kings_drawn:", p.get("kings_drawn"))
        print("Reconnect drawn_pile_top:", p.get("drawn_pile_top"))
        print("Reconnect your_player_id matches:", p.get("your_player_id") == id1)
    else:
        print("Reconnect state_sync: NO")

    await ws1b.close()
    await ws2.close()


if __name__ == "__main__":
    asyncio.run(main())
