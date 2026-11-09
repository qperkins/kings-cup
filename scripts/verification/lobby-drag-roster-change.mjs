// Regression: a join/leave while the host is mid-drag used to leave the dragged lobby row
// stuck at transform: scale(1.03) (overlapping the next row and blocking its menu).
// Needs: frontend on :3000, backend on :8000, global playwright. Usage: node lobby-drag-roster-change.mjs [join|leave]
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { chromium } = require(execSync("npm root -g").toString().trim() + "/playwright");
const BASE = process.env.BASE ?? "http://localhost:3000";
const mode = process.argv[2] ?? "join";
const b = await chromium.launch();
const mk = async () => (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const host = await mk();
await host.goto(BASE);
await host.getByPlaceholder("Enter your name").fill("Ann");
await host.getByRole("button", { name: /create/i }).click();
await host.waitForURL(/\/room\//);
const room = host.url().match(/room\/([A-Z0-9]+)/)[1];
const others = {};
for (const n of ["Ben", "Cat", "Dee"]) { others[n] = await mk(); await others[n].goto(`${BASE}/room/${room}?name=${n}`); }
await host.waitForTimeout(1500);
const a = await host.locator('[aria-label^="Drag to reorder"]').nth(3).boundingBox();
await host.mouse.move(a.x + 8, a.y + 8); await host.mouse.down();
for (let i = 1; i <= 6; i++) await host.mouse.move(a.x + 8, a.y + 8 - 10 * i, { steps: 2 });
if (mode === "join") { const e = await mk(); await e.goto(`${BASE}/room/${room}?name=Eve`); await host.waitForTimeout(1200); }
else { await others.Ben.getByRole("button", { name: /Leave Room/ }).click(); await host.waitForTimeout(1200); }
await host.mouse.up(); await host.waitForTimeout(1500);
const t = await host.locator("div.relative.flex.items-center.justify-between.rounded-lg").evaluateAll(es => es.map(e => e.style.transform));
const stuck = t.filter(x => x && x !== "none");
console.log(stuck.length ? `FAIL stuck rows: ${JSON.stringify(t)}` : "PASS no row stuck after drop");
await b.close();
process.exit(stuck.length ? 1 : 0);
