// Deterministic animated-UI recorder for the RaceIQ analyse cockpit.
//
// Drives the app's own frame index (window.__setFrame) rather than wall-clock,
// so the same index -> identical pixels. Captures full-page 1920x1080 PNG frames
// of the live DOM/SVG cockpit (track dot, gauges, traces) stepping through real
// telemetry, then ffmpeg stitches them into an mp4.
//
// Usage:
//   node record-cockpit.mjs [url] [startFrac] [numFrames] [stride]
//
// MUST run under node, NOT bun. bun (v1.3.14, Windows) does not wire the extra
// pipe file descriptors (fd 3/4) that Playwright's --remote-debugging-pipe CDP
// transport requires, so the browser spawns but the CDP handshake never connects
// and chromium.launch() hangs until its 30s timeout. node connects in ~64ms.
//
// Requires the dev server running with the real session (raceiq.localhost:1355)
// and the LapAnalyse __recording hook (gated by window.__recording).

import { chromium } from "@playwright/test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { resolve } from "path";

const URL =
  process.argv[2] ??
  "http://raceiq.localhost:1355/ac-evo/analyse?track=13&car=68&lap=42";
const START_FRAC = parseFloat(process.argv[3] ?? "0.30");
const NUM_FRAMES = parseInt(process.argv[4] ?? "200", 10);
const STRIDE = parseInt(process.argv[5] ?? "1", 10);
// Fraction of the capture at which to flip the analyse center panel 2D -> 3D
// (0 = never). Demonstrates the 3D car-attitude view mid-clip.
const FLIP_3D_AT = parseFloat(process.argv[6] ?? "0");
// Optional 3D view-orbit schedule: comma-separated "frac:VIEW" pairs where VIEW
// is one of the orbit buttons (3/4, FRONT, REAR, LEFT, RIGHT, TOP). At each
// fraction of the capture the matching button is clicked, so the clip sweeps
// camera angles on the wireframe car. e.g. "0.25:FRONT,0.5:REAR,0.8:TOP,0.92:3/4"
const VIEW_SCHEDULE = (process.argv[7] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((pair) => {
    const [frac, view] = pair.split(":");
    return { frac: parseFloat(frac), view: view.trim() };
  })
  .filter((v) => v.frac >= 0 && v.view);
// Shift the start point earlier in the lap by this many real seconds, resolved
// against the telemetry's own per-frame lap timestamps (window.__frameTimes).
const START_SEC_EARLIER = parseFloat(process.argv[8] ?? "0");
const FRAMES_DIR = resolve(process.env.COCKPIT_FRAMES_DIR ?? "/tmp/raceiq-cockpit-frames");

const log = (m) => console.log(`[cockpit] ${m}`);

// Plain launch: the cockpit is DOM/SVG (no WebGL), so no GPU args — those
// conflict with chrome-headless-shell on Windows and hang the launch.
const browser = await chromium.launch({ headless: true, timeout: 60_000 });
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  ignoreHTTPSErrors: true,
  colorScheme: "dark",
});
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.__recording = true;
  // Deterministically force the display state we want on camera, so the clip
  // never depends on whatever the real user last left in localStorage:
  //  - 3D wireframe: inputs overlay on (throttle/brake/steer trails)
  //  - track map: inputs overlay + follow-cam (auto 3x zoom) + extra zoom
  try {
    localStorage.setItem("carwireframe-toggles", JSON.stringify({ inputs: true }));
    localStorage.setItem("analyse-trackOverlay", JSON.stringify("inputs"));
    localStorage.setItem("analyse-rotateWithCar", JSON.stringify(true));
    localStorage.setItem("analyse-mapZoom", JSON.stringify(1.5));
  } catch {}
});

if (existsSync(FRAMES_DIR)) rmSync(FRAMES_DIR, { recursive: true });
mkdirSync(FRAMES_DIR, { recursive: true });

log(`opening ${URL}`);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

// Wait for the analyse cockpit hook to register a real telemetry length.
await page.waitForFunction(
  () => typeof window.__totalFrames === "number" && window.__totalFrames > 1,
  { timeout: 30_000 },
);
const totalFrames = await page.evaluate(() => window.__totalFrames);
let start = Math.floor(totalFrames * START_FRAC);
// Walk the start index earlier until it is >= START_SEC_EARLIER seconds before
// the fractional start, using the telemetry's real per-frame lap timestamps.
if (START_SEC_EARLIER > 0) {
  const frameTimes = await page.evaluate(() => window.__frameTimes ?? null);
  if (frameTimes && frameTimes[start] != null) {
    const targetT = frameTimes[start] - START_SEC_EARLIER;
    while (start > 0 && frameTimes[start] > targetT) start--;
    log(`shifted start ${START_SEC_EARLIER}s earlier -> frame ${start}`);
  } else {
    log(`__frameTimes unavailable; ignoring START_SEC_EARLIER`);
  }
}
const count = Math.min(NUM_FRAMES, Math.floor((totalFrames - start) / STRIDE));
log(`telemetry packets: ${totalFrames} | start ${start} | capturing ${count} frames (stride ${STRIDE})`);

await page.evaluate(() => window.__pauseAnimation && window.__pauseAnimation());
await page.waitForTimeout(600);

const flipFrame = FLIP_3D_AT > 0 ? Math.floor(count * FLIP_3D_AT) : -1;

// Resolve each view-orbit entry to an absolute frame index.
const viewFrames = VIEW_SCHEDULE.map((v) => ({
  frame: Math.floor(count * v.frac),
  view: v.view,
}));
if (viewFrames.length) log(`view orbit: ${viewFrames.map((v) => `${v.frame}:${v.view}`).join(" ")}`);

const t0 = Date.now();
for (let i = 0; i < count; i++) {
  if (i === flipFrame) {
    log(`flipping center panel 2D -> 3D at frame ${i}`);
    try {
      await page.getByRole("button", { name: "3D", exact: true }).first().click({ timeout: 5000 });
    } catch (e) {
      log(`3D toggle click failed: ${e.message}`);
    }
    await page.waitForTimeout(500); // let the 3D canvas mount + first render
  }
  for (const v of viewFrames) {
    if (i === v.frame) {
      log(`orbit -> ${v.view} at frame ${i}`);
      try {
        await page.getByRole("button", { name: v.view, exact: true }).first().click({ timeout: 5000 });
      } catch (e) {
        log(`view "${v.view}" click failed: ${e.message}`);
      }
      await page.waitForTimeout(300); // let the camera ease to the new angle
    }
  }
  const idx = start + i * STRIDE;
  await page.evaluate((n) => window.__setFrame(n), idx);
  // One RAF settle so track dot + charts overlays repaint for this index.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const padded = String(i).padStart(6, "0");
  await page.screenshot({ path: `${FRAMES_DIR}/frame-${padded}.png`, animations: "disabled" });
  if (i % 20 === 0) log(`frame ${i}/${count} (idx ${idx})`);
}
const dt = ((Date.now() - t0) / 1000).toFixed(1);
log(`done: ${count} frames in ${dt}s -> ${FRAMES_DIR}`);

await browser.close();
