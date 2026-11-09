#!/usr/bin/env python3
"""Full Royal Mayhem game over WebSocket (multi-instance aware).

Usage:
  python ws-e2e-royal-mayhem.py [ws://localhost:8080] [--redis redis://localhost:6379/0] [--failover]

Four clients connect round-robin, so behind the docker-compose nginx they land on
different app instances; every broadcast must reach all four. The deck is stacked
through Redis (the only way to force each of the 12 wildcards in one game), so
--redis must point at the primary the app uses.

With --failover the script also stops `kings-cup-redis-primary-1` mid-wildcard
(pending Royal Duel, mates, reversed direction), waits for sentinel to promote a
replica, reconnects everyone and asserts state_sync rehydrates all of it.
"""
import asyncio
import json
import random
import string
import subprocess
import sys
import uuid

import redis.asyncio as aioredis
import websockets

args = list(sys.argv[1:])
WS_BASE = next((a for a in args if a.startswith("ws")), "ws://localhost:8080")
REDIS_URL = args[args.index("--redis") + 1] if "--redis" in args else "redis://localhost:6379/0"
FAILOVER = "--failover" in args
ROOM = "RM" + "".join(random.choices(string.ascii_uppercase + string.digits, k=6))

fails: list[str] = []


def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {info}"))
    if not cond:
        fails.append(name)


class Client:
    def __init__(self, name):
        self.name, self.ev, self.pid, self.ws = name, [], None, None
        self.resume = None

    async def open(self):
        self.ws = await websockets.connect(f"{WS_BASE}/ws/{ROOM}")
        self.task = asyncio.create_task(self._read())
        await self.send({"type": "join", "player_name": self.name,
                         **({"resume_token": self.resume} if self.resume else {})}, wait=0.6)
        sync = [e for e in self.ev if e["type"] == "state_sync"][-1]["payload"]
        self.pid = sync["your_player_id"]
        self.resume = self.pid
        return self

    async def _read(self):
        try:
            async for raw in self.ws:
                self.ev.append(json.loads(raw))
        except Exception:
            pass

    async def send(self, d, wait=0.3):
        d.setdefault("action_id", str(uuid.uuid4()))
        n = len(self.ev)
        await self.ws.send(json.dumps(d))
        await asyncio.sleep(wait)
        return self.ev[n:]

    def last(self, typ):
        m = [e for e in self.ev if e["type"] == typ]
        return m[-1]["payload"] if m else None


def errors(evs):
    return [e for e in evs if e["type"] == "error"]


def std(rank, suit="hearts"):
    return {"rank": rank, "suit": suit, "kind": "standard", "wild_id": None}


def wild(w):
    return {"rank": None, "suit": None, "kind": "wild", "wild_id": w}


async def redis_state(r):
    return json.loads(await r.get(f"room:{ROOM}:state"))


async def stack(r, plan):
    """plan is in draw order; the engine pops from the end of the deck."""
    st = await redis_state(r)
    st["deck"] = list(reversed(plan))
    await r.set(f"room:{ROOM}:state", json.dumps(st))


async def actor(r, clients):
    st = await redis_state(r)
    pid = {p["seat"]: p["id"] for p in st["players"]}[st["current_turn_seat"]]
    return next(c for c in clients if c.pid == pid)


def marks(clients):
    return {c.name: len(c.ev) for c in clients}


def all_got(clients, typ, since):
    return all(any(e["type"] == typ for e in c.ev[since[c.name]:]) for c in clients)


async def main():
    print(f"Room {ROOM} via {WS_BASE}")
    r = aioredis.from_url(REDIS_URL)
    cs = [await Client(n).open() for n in ["Ann", "Ben", "Cat", "Dan"]]
    host = cs[0]

    # ---- lobby: mode, reorder, shuffle ----
    evs = await cs[1].send({"type": "set_game_mode", "player_id": cs[1].pid, "mode": "royal_mayhem"})
    check("non-host set_game_mode rejected", bool(errors(evs)))
    m = marks(cs)
    await host.send({"type": "set_game_mode", "player_id": host.pid, "mode": "royal_mayhem"}, wait=0.6)
    check("set_game_mode reaches all clients", all_got(cs, "settings_updated", m))
    check("settings_updated carries game_mode", all(c.last("settings_updated").get("game_mode") == "royal_mayhem" for c in cs))

    m = marks(cs)
    order = [cs[3].pid, cs[2].pid, cs[1].pid, cs[0].pid]
    await host.send({"type": "reorder_players", "player_id": host.pid, "order": order}, wait=0.6)
    check("players_reordered reaches all clients", all_got(cs, "players_reordered", m))
    check("reorder applied everywhere", all([p["id"] for p in c.last("players_reordered")["players"]] == order for c in cs))
    m = marks(cs)
    await host.send({"type": "shuffle_players", "player_id": host.pid}, wait=0.6)
    check("shuffle_players reaches all clients", all_got(cs, "players_reordered", m))
    seats = sorted(p["seat"] for p in cs[0].last("players_reordered")["players"])
    check("seats compacted 0..3", seats == [0, 1, 2, 3], seats)

    await host.send({"type": "start_game"}, wait=0.6)
    check("game_started to all", all(any(e["type"] == "game_started" for e in c.ev) for c in cs))
    st = await redis_state(r)
    check("royal_mayhem deck is 64 cards / 12 wild",
          len(st["deck"]) == 64 and sum(1 for c in st["deck"] if c["kind"] == "wild") == 12, len(st["deck"]))

    plan = [std("8"), std("8", "spades"), wild("reverse"), wild("exile"), wild("encore"), std("2"),
            wild("scepter"), wild("duel"), wild("treason"), wild("jester"), wild("plague"),
            wild("pardon"), wild("silence"), wild("king_chaos_a"), std("K", "hearts"),
            std("K", "spades"), std("K", "clubs"), std("K", "diamonds"), wild("king_chaos_b")]
    await stack(r, plan)

    async def draw():
        a = await actor(r, cs)
        m = marks(cs)
        await a.send({"type": "draw_card", "player_id": a.pid}, wait=0.7)
        cd = a.last("card_drawn")
        label = cd["card"].get("wild_id") or cd["card"].get("rank")
        check(f"card_drawn broadcast to all ({label})", all_got(cs, "card_drawn", m))
        return a, cd

    # 8 -> two mate pairs
    a, _ = await draw()
    b = next(c for c in cs if c is not a)
    m = marks(cs)
    await a.send({"type": "choose_mate", "player_id": a.pid, "mate_id": b.pid}, wait=0.6)
    check("mate_chosen reaches all", all_got(cs, "mate_chosen", m))
    a2, _ = await draw()
    cands = [c for c in cs if c is not a2 and {a2.pid, c.pid} != {a.pid, b.pid}]
    await a2.send({"type": "choose_mate", "player_id": a2.pid, "mate_id": cands[0].pid}, wait=0.6)
    check("second mate pair stored", len((await redis_state(r))["mates"]) == 2)

    # reverse
    a, cd = await draw()
    st = await redis_state(r)
    seat_of = {p["id"]: p["seat"] for p in st["players"]}
    check("reverse: direction_changed reaches all, dir=-1",
          all(any(e["type"] == "direction_changed" for e in c.ev) for c in cs) and st["direction"] == -1)
    check("reverse: turn moved to previous seat", st["current_turn_seat"] == (seat_of[a.pid] - 1) % 4, st["current_turn_seat"])

    # exile
    a, cd = await draw()
    check("exile names player + 1 shot (or 3 drinks)",
          "1 shot (or 3 drinks)" in cd["rule_text"] and "skipped" in cd["rule_text"], cd["rule_text"])
    check("player_exiled reaches all", all(any(e["type"] == "player_exiled" for e in c.ev) for c in cs))

    # encore: same player draws again
    a, cd = await draw()
    st = await redis_state(r)
    check("encore: same player still active", st["current_turn_seat"] == seat_of[a.pid])
    await draw()  # the "2"

    # scepter
    a, cd = await draw()
    check("scepter says 3 drinks", "3 drinks" in cd["rule_text"], cd["rule_text"])
    st = await redis_state(r)
    check("scepter battle kind=rps", bool(st["battle"]) and st["battle"]["kind"] == "rps")
    evs = await a.send({"type": "resolve_battle", "player_id": a.pid, "loser_id": None})
    check("scepter null loser rejected (no tie)", bool(errors(evs)))
    m = marks(cs)
    await a.send({"type": "resolve_battle", "player_id": a.pid, "loser_id": st["battle"]["opponent_id"]}, wait=0.6)
    check("battle_resolved reaches all", all_got(cs, "battle_resolved", m))

    # duel
    a, cd = await draw()
    check("duel wording", "1 shot (or 3 drinks)" in cd["rule_text"], cd["rule_text"])
    tgt = next(c for c in cs if c is not a)
    m = marks(cs)
    await a.send({"type": "choose_target", "player_id": a.pid, "target_id": tgt.pid}, wait=0.6)
    check("duel battle broadcast to all", all_got(cs, "input_required", m))
    await a.send({"type": "resolve_battle", "player_id": a.pid, "loser_id": tgt.pid}, wait=0.6)

    # treason
    a, cd = await draw()
    check("treason wording", "1 shot (or 3 drinks)" in cd["rule_text"], cd["rule_text"])
    pair = (await redis_state(r))["mates"][0]
    m = marks(cs)
    await a.send({"type": "break_mate", "player_id": a.pid, "a": pair[0], "b": pair[1]}, wait=0.6)
    check("mate_broken reaches all", all_got(cs, "mate_broken", m))
    check("pair removed", len((await redis_state(r))["mates"]) == 1)

    # table-resolved wildcards
    for w in ["jester", "plague", "pardon", "silence"]:
        a, cd = await draw()
        t = cd["rule_text"].lower()
        check(f"{w}: no 'sip' / 'drink 1 shot'", "sip" not in t and "drink 1 shot" not in t, cd["rule_text"])
        if w in ("jester", "plague"):
            check(f"{w} says take(s) 1 shot (or 3 drinks)", "1 shot (or 3 drinks)" in t, cd["rule_text"])

    # kings -> 6th king ends it
    for _ in range(6):
        await draw()
        if (await redis_state(r))["phase"] == "finished":
            break
    st = await redis_state(r)
    check("game finishes on the 6th King", st["phase"] == "finished" and st["kings_drawn"] == 6, (st["phase"], st["kings_drawn"]))
    check("game_finished reaches all", all(any(e["type"] == "game_finished" for e in c.ev) for c in cs))

    if FAILOVER:
        await failover_phase(r, cs)

    for c in cs:
        await c.ws.close()
    print("\nFAILED:" if fails else "\nALL CHECKS PASSED", fails or "")
    sys.exit(1 if fails else 0)


async def failover_phase(r, cs):
    print("\n--- failover: restart game, pause mid-duel ---")
    host = cs[0]
    await host.send({"type": "restart_game", "player_id": host.pid}, wait=0.6)
    await stack(r, [std("8"), wild("reverse"), wild("duel")] + [std("2")] * 10)

    async def draw():
        a = await actor(r, cs)
        await a.send({"type": "draw_card", "player_id": a.pid}, wait=0.6)
        return a

    a = await draw()
    b = next(c for c in cs if c is not a)
    await a.send({"type": "choose_mate", "player_id": a.pid, "mate_id": b.pid}, wait=0.5)
    await draw()  # reverse
    await draw()  # duel -> pending pick
    st = await redis_state(r)
    keys = ("mates", "direction", "game_mode", "pending_input", "current_turn_seat")
    snapshot = {k: st[k] for k in keys}
    print("pre-failover:", snapshot)
    check("pre-failover has pending duel", bool(snapshot["pending_input"]) and snapshot["pending_input"]["kind"] == "duel")

    print("docker stop kings-cup-redis-primary-1 ...")
    subprocess.run(["docker", "stop", "kings-cup-redis-primary-1"], check=True, capture_output=True)
    for c in cs:
        await c.ws.close()

    ok = False
    for i in range(30):
        await asyncio.sleep(3)
        try:
            for c in cs:
                c.ev.clear()
                await c.open()
            ok = True
            break
        except Exception as exc:
            print(f"  waiting for promotion ({(i + 1) * 3}s): {type(exc).__name__}")
    check("clients reconnect after sentinel promotion", ok)
    if not ok:
        return
    for c in cs:
        sync = [e for e in c.ev if e["type"] == "state_sync"][-1]["payload"]
        got = {k: sync[k] for k in keys}
        check(f"state_sync after failover rehydrates for {c.name}", got == snapshot, (got, snapshot))
    c = next(c for c in cs if c.pid == snapshot["pending_input"]["player_id"])
    tgt = next(x for x in cs if x is not c)
    await c.send({"type": "choose_target", "player_id": c.pid, "target_id": tgt.pid}, wait=1.0)
    check("pending duel completes after failover", any(e["type"] == "input_required" for e in c.ev[-6:]))
    subprocess.run(["docker", "start", "kings-cup-redis-primary-1"], capture_output=True)


asyncio.run(main())
