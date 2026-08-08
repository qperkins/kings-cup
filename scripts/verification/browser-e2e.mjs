/**
 * Browser E2E via Playwright. Run:
 *   npx -p playwright@1.49.0 node scripts/verification/browser-e2e.mjs
 * Requires: backend on ws://localhost:8080, frontend on http://localhost:3000
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ROOM = "BROW" + Math.random().toString(36).slice(2, 6).toUpperCase();

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const tab1 = await ctx1.newPage();
  const tab2 = await ctx2.newPage();

  const errors1 = [];
  tab1.on("console", (msg) => {
    if (msg.type() === "error") errors1.push(msg.text());
  });

  console.log("=== Happy path (2 tabs) ===");
  console.log("Room:", ROOM);

  await tab1.goto(`${BASE}/room/${ROOM}?name=Alice`);
  await tab1.waitForTimeout(1500);
  const p1Lobby = await tab1.textContent("body");
  console.log("Tab1 lobby shows Alice:", p1Lobby?.includes("Alice") ?? false);
  console.log("Tab1 lobby Host visible:", p1Lobby?.includes("Host") ?? false);
  console.log("Tab1 error banner:", (await tab1.locator(".text-destructive").count()) > 0);

  await tab2.goto(`${BASE}/room/${ROOM}?name=Bob`);
  await tab2.waitForTimeout(1500);
  const p2Lobby = await tab2.textContent("body");
  console.log("Tab2 shows 2 players:", p2Lobby?.includes("Players (2)") ?? false);
  console.log("Tab2 error banner:", (await tab2.locator(".text-destructive").count()) > 0);

  await tab1.getByRole("button", { name: "Start Game" }).click();
  await tab1.waitForTimeout(1500);
  await tab2.waitForTimeout(1000);
  console.log("Tab1 game board (Draw Card):", await tab1.getByRole("button", { name: "Draw Card" }).isVisible().catch(() => false));
  const turnText = (await tab1.textContent("body"))?.match(/Your turn|Waiting for/)?.[0] ?? "";
  const deckLeft = (await tab1.textContent("body"))?.match(/(\d+) left/)?.[1] ?? "?";
  const drawEnabled = await tab1.getByRole("button", { name: "Draw Card" }).isEnabled().catch(() => false);
  console.log("Tab1 turn text:", turnText);
  console.log("Tab1 deck remaining:", deckLeft);
  console.log("Tab1 Draw enabled:", drawEnabled);
  console.log(
    "Tab1 turn/draw/deck consistent:",
    turnText === "Your turn" && drawEnabled && deckLeft !== "0",
  );
  console.log("Tab2 game board visible:", (await tab2.textContent("body"))?.includes("left") ?? false);

  if (!drawEnabled) {
    throw new Error(`Draw button disabled at game start (deck=${deckLeft}, turn=${turnText})`);
  }
  await tab1.getByRole("button", { name: "Draw Card" }).click();
  await tab1.waitForTimeout(1200);
  await tab2.waitForTimeout(800);
  const body1 = await tab1.textContent("body");
  const body2 = await tab2.textContent("body");
  console.log("After draw tab1 shows rule/card:", body1?.includes("Kings:") && !body1?.includes("0 drawn") || body1?.match(/Round \d+/));
  console.log("After draw tab2 synced:", body2?.includes("Kings:") ?? false);
  console.log("Tab1 error after draw:", (await tab1.locator(".text-destructive").count()) > 0);

  console.log("\n=== Reconnect (mid-game refresh) ===");
  await tab1.reload();
  await tab1.waitForTimeout(2000);
  const reBody = await tab1.textContent("body");
  const refreshDeckLeft = reBody?.match(/(\d+) left/)?.[1];
  console.log("After refresh still in game:", reBody?.includes("Draw Card") || reBody?.includes("Waiting for"));
  console.log("After refresh deck count (not 52):", refreshDeckLeft && refreshDeckLeft !== "52");
  console.log("After refresh kings counter present:", reBody?.includes("Kings:") ?? false);
  console.log("After refresh last card area (not empty Discard only):", reBody?.includes("Discard") ? !reBody?.includes("Discard\n") : true);
  console.log("After refresh error banner:", (await tab1.locator(".text-destructive").count()) > 0);

  console.log("\n=== Lock contention (rapid dual draw) ===");
  // Bob's turn after one draw from Alice - try both clicking draw quickly
  const draw1 = tab1.getByRole("button", { name: "Draw Card" });
  const draw2 = tab2.getByRole("button", { name: "Draw Card" });
  const t1Visible = await draw1.isVisible().catch(() => false);
  const t2Visible = await draw2.isVisible().catch(() => false);
  if (t1Visible || t2Visible) {
    await Promise.all([
      t1Visible ? draw1.click().catch(() => {}) : Promise.resolve(),
      t2Visible ? draw2.click().catch(() => {}) : Promise.resolve(),
    ]);
    await tab1.waitForTimeout(3000);
    await tab2.waitForTimeout(500);
    const err1 = await tab1.locator(".text-destructive").textContent().catch(() => null);
    const err2 = await tab2.locator(".text-destructive").textContent().catch(() => null);
    console.log("Tab1 error text after dual draw:", err1 ?? "(none)");
    console.log("Tab2 error text after dual draw:", err2 ?? "(none)");
    console.log("Tab1 shows Room busy (should NOT flash during transparent retry):", err1?.includes("Room busy") ?? false);
  } else {
    console.log("Skip dual draw — neither tab had Draw Card visible (turn order)");
  }

  await browser.close();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
