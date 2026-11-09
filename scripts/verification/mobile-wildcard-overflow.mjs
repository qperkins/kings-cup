// Regression: on a 375px phone, a Royal Mayhem wildcard's reveal flash (-inset-10, scale 1.4) used to widen
// the page to ~448px, which shifted/clipped fixed popups (Treason!, Game Over).
// Needs: frontend :3000, backend :8000, redis on :6379/0, global playwright, python venv with redis (PY env var).
import { createRequire } from "node:module";
import { execSync, execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { chromium } = require(execSync("npm root -g").toString().trim() + "/playwright");
const BASE = process.env.BASE ?? "http://localhost:3000";
const PY = process.env.PY ?? "python3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stack = (room, plan) => execFileSync(PY, ["-c", `
import redis,json
r=redis.Redis.from_url("redis://localhost:6379/0");k="room:${room}:state";s=json.loads(r.get(k))
c=lambda x:{"rank":None,"suit":None,"kind":"wild","wild_id":x[2:]} if x.startswith("w:") else {"rank":x,"suit":"hearts","kind":"standard","wild_id":None}
s["deck"]=[c(x) for x in reversed(${JSON.stringify(plan)})];r.set(k,json.dumps(s))`]);
const b = await chromium.launch();
const host = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const phone = await (await b.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })).newPage();
await host.goto(BASE); await host.getByPlaceholder("Enter your name").fill("Ann");
await host.getByRole("button", { name: /create/i }).click(); await host.waitForURL(/\/room\//);
const room = host.url().match(/room\/([A-Z0-9]+)/)[1];
await phone.goto(`${BASE}/room/${room}?name=Mob`); await sleep(1500);
await host.getByRole("button", { name: /Royal Mayhem/ }).click(); await sleep(600);
await host.getByRole("button", { name: "Start Game" }).click(); await sleep(1500);
stack(room, ["w:jester", "2-hearts"]);
await host.mouse.click(5, 5); await sleep(500);
await host.getByRole("button", { name: "DRAW CARD" }).click();
let worst = 0;
for (let i = 0; i < 10; i++) { worst = Math.max(worst, await phone.evaluate(() => document.documentElement.scrollWidth)); await sleep(200); }
console.log(worst <= 375 ? `PASS phone scrollWidth stayed ${worst}` : `FAIL phone scrollWidth reached ${worst} (>375)`);
await b.close(); process.exit(worst <= 375 ? 0 : 1);
