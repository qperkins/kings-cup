// Regression: refreshing while you owe a Royal Duel pick used to show "Your turn, tap to draw a card"
// (popup + chime) even though you can't draw yet. Needs frontend :3000, backend :8000, redis :6379/0, global playwright.
// PY=/path/to/python-with-redis node turn-popup-refresh-blocked.mjs
import { createRequire } from "node:module";
import { execSync, execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { chromium } = require(execSync("npm root -g").toString().trim() + "/playwright");
const BASE = process.env.BASE ?? "http://localhost:3000";
const PY = process.env.PY ?? "python3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();
const mk = async () => (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const a = await mk(), c = await mk();
await a.goto(BASE); await a.getByPlaceholder("Enter your name").fill("Ann");
await a.getByRole("button", { name: /create/i }).click(); await a.waitForURL(/\/room\//);
const room = a.url().match(/room\/([A-Z0-9]+)/)[1];
await c.goto(`${BASE}/room/${room}?name=Cat`); await sleep(1500);
await a.getByRole("button", { name: /Royal Mayhem/ }).click(); await sleep(600);
await a.getByRole("button", { name: "Start Game" }).click(); await sleep(1500);
execFileSync(PY, ["-c", `
import redis,json
r=redis.Redis.from_url("redis://localhost:6379/0");k="room:${room}:state";s=json.loads(r.get(k))
s["deck"]=[{"rank":"2","suit":"hearts","kind":"standard","wild_id":None}]*2+[{"rank":None,"suit":None,"kind":"wild","wild_id":"duel"}];r.set(k,json.dumps(s))`]);
await a.mouse.click(5, 5); await sleep(500);
await a.getByRole("button", { name: "DRAW CARD" }).click(); await sleep(900); await a.mouse.click(5, 5); await sleep(600);
await a.reload(); await sleep(2000);
const alerts = await a.locator("div[role=alert].fixed").count();
const picker = await a.getByText("Royal Duel: pick your rival").count();
console.log(alerts === 0 && picker === 1 ? "PASS no turn popup while blocked; picker still shown" : `FAIL alerts=${alerts} picker=${picker}`);
await b.close(); process.exit(alerts === 0 && picker === 1 ? 0 : 1);
