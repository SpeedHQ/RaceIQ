// Deterministic animated-UI recorder for the RaceIQ **compare** view.
// Unlike the cockpit recorder (which drives window.__setFrame), the compare
// view has no frame hook. Instead we drive the uPlot cursor by moving the real
// mouse across the first chart's `.u-over` layer — uPlot syncs every chart and
// fires onCursorMove, which walks the track dot along the racing line. This is
// fully deterministic: frame i maps to a fixed x fraction of the chart width.
//
// Args (positional, all optional after URL):
//   URL          compare page, e.g.
//                http://raceiq.localhost:1355/ac-evo/compare?routes=125/12,125/8
//   scale        deviceScaleFactor          (default 1)
//   frames       number of frames to sweep  (default 300)
//   settleRAF    RAF settles per frame       (default 2)
//   startFrac    sweep start x-fraction     (default 0.02)
//   endFrac      sweep end x-fraction       (default 0.98)
//
// Env:
//   COMPARE_FRAMES_DIR  output dir for frame-%06d.png (default tmp)
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.argv[2] ?? 'http://raceiq.localhost:1355/ac-evo/compare';
const SCALE = parseFloat(process.argv[3] ?? '1');
const NUM_FRAMES = parseInt(process.argv[4] ?? '300', 10);
const SETTLE_RAF = parseInt(process.argv[5] ?? '2', 10);
const START_FRAC = parseFloat(process.argv[6] ?? '0.02');
const END_FRAC = parseFloat(process.argv[7] ?? '0.98');

const FRAMES_DIR =
  process.env.COMPARE_FRAMES_DIR ??
  'C:/Users/acoop/AppData/Local/Temp/raceiq-compare-frames';

// Fresh frames dir.
if (existsSync(FRAMES_DIR)) rmSync(FRAMES_DIR, { recursive: true, force: true });
mkdirSync(FRAMES_DIR, { recursive: true });

// Launch via TCP debug port + connectOverCDP instead of Playwright's default
// --remote-debugging-pipe. The pipe (fd 3/4) handshake intermittently hangs
// under bun on Windows due to a handle-inheritance race — pid spawns but the
// transport never completes (see HANDOVER). A TCP WebSocket transport avoids
// the inherited pipe fds entirely. --remote-allow-origins=* is required for
// CDP WS connections on Chrome 111+ (else the ws upgrade gets a 403).
const DEBUG_PORT = 9333 + Math.floor(Math.random() * 400);
const profileDir = join(tmpdir(), `raceiq-cdp-${process.pid}-${DEBUG_PORT}`);
const exe = chromium.executablePath();
const chromeProc = spawn(
  exe,
  [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-color-profile=srgb',
    '--no-startup-window',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-allow-origins=*',
  ],
  { stdio: 'ignore' },
);

// Poll the DevTools /json/version endpoint for the WS debugger URL.
let wsEndpoint;
for (let i = 0; i < 120; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    if (r.ok) {
      const j = await r.json();
      if (j.webSocketDebuggerUrl) {
        wsEndpoint = j.webSocketDebuggerUrl;
        break;
      }
    }
  } catch {
    // browser not listening yet
  }
  await new Promise((res) => setTimeout(res, 250));
}
if (!wsEndpoint) {
  try { chromeProc.kill(); } catch {}
  throw new Error(`chrome-headless-shell never opened debug port ${DEBUG_PORT}`);
}
const browser = await chromium.connectOverCDP(wsEndpoint);

const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: SCALE,
  colorScheme: 'dark',
  ignoreHTTPSErrors: true,
});

// Match cockpit recorder: force dark theme + skip any onboarding overlays that
// would occlude the charts.
await context.addInitScript(() => {
  try {
    localStorage.setItem('raceiq-color-scheme', 'dark');
    localStorage.setItem('raceiq-onboarding-done', 'true');
    localStorage.setItem('compare-ai-panel-open', 'false');
  } catch {}
});

const page = await context.newPage();
await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });

// Wait for the compare charts to mount — uPlot renders a `.u-over` layer per
// chart once telemetry has loaded and routes resolved.
await page.waitForSelector('.u-over', { timeout: 30_000 });
// Small settle so all synced charts + the track map have laid out.
await page.waitForTimeout(1500);

// Grab the first chart's over-layer box in viewport coords. Moving the real
// mouse here fires uPlot's native cursor → syncs all charts + onCursorMove.
const box = await page.locator('.u-over').first().boundingBox();
if (!box) {
  console.error('FATAL: no .u-over bounding box — compare charts not present');
  await browser.close();
  try { chromeProc.kill(); } catch {}
  process.exit(1);
}

const y = box.y + box.height / 2;
const x0 = box.x + box.width * START_FRAC;
const x1 = box.x + box.width * END_FRAC;

console.log(
  `compare sweep: ${NUM_FRAMES} frames, over-box ${Math.round(box.width)}x${Math.round(box.height)} @ (${Math.round(box.x)},${Math.round(box.y)})`,
);

for (let i = 0; i < NUM_FRAMES; i++) {
  const t = NUM_FRAMES === 1 ? 0 : i / (NUM_FRAMES - 1);
  const x = x0 + (x1 - x0) * t;
  await page.mouse.move(x, y);
  // Let uPlot's cursor + our onCursorMove settle across RAFs.
  for (let r = 0; r < SETTLE_RAF; r++) {
    await page.evaluate(
      () => new Promise((res) => requestAnimationFrame(() => res())),
    );
  }
  const frame = String(i).padStart(6, '0');
  await page.screenshot({ path: `${FRAMES_DIR}/frame-${frame}.png` });
  if (i % 30 === 0) console.log(`frame ${i}/${NUM_FRAMES} (x-frac ${t.toFixed(3)})`);
}

console.log(`done. ${NUM_FRAMES} frames -> ${FRAMES_DIR}`);
await browser.close();
try { chromeProc.kill(); } catch {}
