import { chromium } from "@playwright/test";
import { mkdirSync, rmSync, existsSync } from "fs";

const FRAMES_DIR = "/tmp/trackmap-frames";
const TOTAL = 396;

if (existsSync(FRAMES_DIR)) rmSync(FRAMES_DIR, { recursive: true });
mkdirSync(FRAMES_DIR, { recursive: true });

const browser = await chromium.connectOverCDP("http://localhost:9333");
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
await page.setViewportSize({ width: 440, height: 440 });
await page.goto("http://localhost:5183/capture.html");
await page.waitForFunction(() => (window).__captureReady === true, { timeout: 20000 });

const root = page.locator("#root > div");

for (let i = 0; i < TOTAL; i++) {
  await page.evaluate((n) => (window).__setFrame(n), i);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined)))));
  const padded = String(i).padStart(6, "0");
  await root.screenshot({ path: `${FRAMES_DIR}/frame-${padded}.png` });
  if (i % 50 === 0) console.log(`frame ${i}/${TOTAL}`);
}

await page.close();
console.log("done");
process.exit(0);
