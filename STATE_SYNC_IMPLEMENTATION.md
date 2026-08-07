# State Sync Implementation Summary

## What Was Added

Added targeted `state_sync` event that includes `your_player_id` field, solving the client self-identification problem for joining and reconnecting players.

## Problem Solved

**Before:** Clients received only broadcast events (`player_joined`, `player_reconnected`) which go to ALL clients in the room. A client couldn't determine "which player is me" because it would see these broadcasts for other players too.

**After:** Clients receive a targeted `state_sync` event (via `send_to()`, not broadcast) that includes:
1. Full game state (room, phase, players, turn, cards, etc.)
2. `your_player_id` field identifying which player in the roster is them

## Implementation

### 1. GameState.to_client_view() Method

**File:** `game_engine/models.py`

Added method that serializes game state for client consumption:

```python
def to_client_view(self) -> dict:
    return {
        "room_id": self.room_id,
        "phase": self.phase.value,
        "players": [p.model_dump() for p in self.players],
        "current_turn_seat": self.current_turn_seat,
        "kings_drawn": self.kings_drawn,
        "cards_remaining": len(self.deck),
        "drawn_pile_top": {
            **self.drawn_pile[-1].model_dump(),
            "rule_text": self.drawn_pile[-1].rule_text(),
        } if self.drawn_pile else None,
    }
```

**Key Design Decisions:**

- `your_player_id` is NOT included in the method itself - it's added by the caller (main.py) because it varies per recipient
- `drawn_pile_top` includes `rule_text` to match `card_drawn` event shape
- Without `rule_text`, reconnecting clients would need to reimplement the rank→rule mapping in TypeScript, duplicating business logic
- Server-authoritative: game rules live server-side, not in client code

### 2. Send state_sync After Join/Reconnect

**File:** `game_engine/main.py`

After successful join/reconnect (lines 96-112):

```python
player_id = result.events[-1].payload.get("id") if result.events else None
event["player_id"] = player_id
if player_id:
    await manager.connect(room_id, player_id, websocket)
    # Broadcast roster update to all clients
    for e in result.events:
        await manager.publish(room_id, e)
    
    # Send full state to this specific client for self-identification
    payload = result.state.to_client_view()
    payload["your_player_id"] = player_id
    await manager.send_to(
        room_id, 
        player_id,
        ServerEvent(type="state_sync", payload=payload)
    )
event["outcome"] = "success"
```

**Flow:**
1. Player joins or reconnects
2. Broadcast roster update to all clients (`player_joined` or `player_reconnected`)
3. Send targeted `state_sync` to the specific joining/reconnecting player
4. Client receives both: roster update (broadcast) + state sync (targeted with their player_id)

## Event Flow Diagram

### Fresh Join

```
Player A joins
  ↓
1. Broadcast player_joined to ALL clients (roster update)
2. Send state_sync to Player A only
   - Includes full game state
   - Includes your_player_id: "A"
  ↓
Player A's client now knows:
  - Who all the players are (from roster)
  - Which player is "me" (from your_player_id)
```

### Reconnect

```
Player A reconnects (with resume_token)
  ↓
1. Broadcast player_reconnected to ALL clients
2. Send state_sync to Player A only
   - Includes current game state
   - Includes your_player_id: "A"
  ↓
Player A's client catches up to current state
```

### Multi-Player Scenario

```
Player B joins while Player A is already connected
  ↓
Player A receives: player_joined broadcast (sees B joined)
Player B receives: 
  - player_joined broadcast (sees themselves in roster)
  - state_sync with your_player_id: "B" (knows "I am B")
```

## Event Types Summary

| Event | Direction | Recipients | Payload Includes | Purpose |
|-------|-----------|------------|------------------|---------|
| `player_joined` | Broadcast | All clients in room | Player details | Roster update |
| `player_reconnected` | Broadcast | All clients in room | Player details | Roster update |
| `state_sync` | Targeted | Specific player | Full state + `your_player_id` | Self-identification + state catch-up |

## State Sync Payload Shape

```typescript
{
  room_id: string;
  phase: 'lobby' | 'in_progress' | 'finished';
  players: Array<{
    id: string;
    name: string;
    seat: number;
    connected: boolean;
  }>;
  current_turn_seat: number;
  kings_drawn: number;
  cards_remaining: number;
  drawn_pile_top: {
    rank: string;
    suit: string;
    rule_text: string;  // Server-authoritative: no client-side rule mapping needed
  } | null;
  your_player_id: string;  // "Which player in the roster is me"
}
```

## Files Changed

1. **`game_engine/models.py`**: Added `GameState.to_client_view()` method (41 lines)
2. **`game_engine/main.py`**: Send `state_sync` after join/reconnect (9 lines)

## Contract Compliance

✅ **Additive only**: No existing ServerEvent fields changed  
✅ **No models.py field changes**: `your_player_id` is payload metadata, not stored state  
✅ **Frontend-ready**: Frontend can use `state_sync.your_player_id` immediately  
✅ **Server-authoritative**: Rule text comes from server, no client-side duplication  
✅ **Documented**: Return shape fully documented in docstring

## Frontend Integration

Frontend should:

1. Listen for `state_sync` event (only received by this client)
2. Extract `your_player_id` from payload
3. Store it as "my player identity"
4. Use it to determine "is it my turn?" by comparing with `current_turn_seat`

Example:
```typescript
socket.on('state_sync', (data) => {
  const myPlayerId = data.your_player_id;
  const myPlayer = data.players.find(p => p.id === myPlayerId);
  const isMyTurn = myPlayer?.seat === data.current_turn_seat;
  
  // Now client knows unambiguously: "I am this player, it is/isn't my turn"
});
```

## Testing Checklist

- [ ] Join test: New player receives `state_sync` with correct `your_player_id`
- [ ] Reconnect test: Player with `resume_token` receives `state_sync` with same `player_id`
- [ ] Multi-player test: Each player receives their own unique `your_player_id`
- [ ] Broadcast separation: Player A doesn't receive `state_sync` when Player B joins
- [ ] Mid-game reconnect: Player receives `drawn_pile_top` with `rule_text`

## Why This Matters

This completes the server-authoritative architecture:
- Server decides game state
- Server decides whose turn it is
- Server decides rule text for cards
- **Server tells each client which player they are**

No ambiguity, no client-side guessing, no race conditions in self-identification.
