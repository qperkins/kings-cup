/** Native WebSocket smoke test (Node 22+). */
const WS_BASE = process.argv[2] ?? "ws://localhost:8080";
const ROOM = "SMOKE" + Math.random().toString(36).slice(2, 6).toUpperCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(roomId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/${roomId}`);
    const events = [];
    ws.addEventListener("message", (ev) => events.push(JSON.parse(ev.data)));
    ws.addEventListener("open", () => resolve({ ws, events }));
    ws.addEventListener("error", reject);
  });
}

function send(ws, intent) {
  ws.send(JSON.stringify({ action_id: crypto.randomUUID(), ...intent }));
}

async function join(ws, name, resumeToken) {
  send(ws, {
    type: "join",
    player_name: name,
    ...(resumeToken ? { resume_token: resumeToken } : {}),
  });
  await sleep(600);
}

async function main() {
  console.log(`Room: ${ROOM}, WS: ${WS_BASE}`);

  const p1 = await connect(ROOM);
  await join(p1.ws, "Alice");
  const sync1 = p1.events.find((e) => e.type === "state_sync");
  const id1 = sync1?.payload?.your_player_id;
  console.log("P1 state_sync:", sync1 ? "yes" : "NO", "your_player_id:", id1);
  console.log("P1 drawn_pile_top:", sync1?.payload?.drawn_pile_top ?? null);

  const p2 = await connect(ROOM);
  await join(p2.ws, "Bob");
  const sync2 = p2.events.find((e) => e.type === "state_sync");
  console.log(
    "P2 state_sync:",
    sync2 ? "yes" : "NO",
    "players:",
    sync2?.payload?.players?.length ?? 0,
  );

  send(p1.ws, { type: "start_game" });
  await sleep(600);
  console.log("game_started:", p1.events.some((e) => e.type === "game_started"));

  send(p1.ws, { type: "draw_card", player_id: id1 });
  await sleep(600);
  const drawn = p1.events.find((e) => e.type === "card_drawn");
  console.log(
    "card_drawn:",
    drawn
      ? `${drawn.payload.card.rank} of ${drawn.payload.card.suit} (${drawn.payload.rule_text})`
      : "NO",
  );

  p1.ws.close();
  await sleep(300);

  const p1b = await connect(ROOM);
  await join(p1b.ws, "Alice", id1);
  await sleep(600);
  const resync = p1b.events.find((e) => e.type === "state_sync");
  if (resync) {
    const p = resync.payload;
    console.log("Reconnect phase:", p.phase);
    console.log("Reconnect cards_remaining:", p.cards_remaining);
    console.log("Reconnect current_turn_seat:", p.current_turn_seat);
    console.log("Reconnect kings_drawn:", p.kings_drawn);
    console.log("Reconnect drawn_pile_top:", JSON.stringify(p.drawn_pile_top));
    console.log("Reconnect your_player_id matches:", p.your_player_id === id1);
  } else {
    console.log("Reconnect state_sync: NO");
  }

  // Rapid concurrent draws from both tabs (lock contention probe)
  const turnSeat = resync?.payload?.current_turn_seat ?? 0;
  const players = resync?.payload?.players ?? [];
  const current = players.find((pl) => pl.seat === turnSeat);
  if (current) {
    send(p1b.ws, { type: "draw_card", player_id: current.id });
    send(p2.ws, { type: "draw_card", player_id: players.find((pl) => pl.id !== current.id)?.id });
    await sleep(1500);
    const busy1 = p1b.events.filter((e) => e.type === "error" && e.payload?.detail === "Room busy, please retry");
    const busy2 = p2.events.filter((e) => e.type === "error" && e.payload?.detail === "Room busy, please retry");
    console.log("Lock contention errors p1:", busy1.length, "p2:", busy2.length);
  }

  p1b.ws.close();
  p2.ws.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
