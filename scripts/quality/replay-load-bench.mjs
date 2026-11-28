import { chromium } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';

const [url, count = '5', slowdown = '4'] = process.argv.slice(2);
const runs = Number(count);
const rate = Number(slowdown);
if (!url || !Number.isInteger(runs) || runs < 1 || !Number.isFinite(rate) || rate < 1) {
  throw new Error('Usage: node scripts/quality/replay-load-bench.mjs REPLAY_URL [RUNS] [CPU_SLOWDOWN]');
}
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--enable-unsafe-swiftshader', '--enable-precise-memory-info'] });
try {
  for (let run = 1; run <= runs; run++) {
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => {
        window.__recording = true;
        const observer = new MutationObserver(() => {
          if (document.querySelector('[data-scene-ready="true"] canvas[data-renderer-backend]')) {
            performance.mark('replay-scene-ready');
            observer.disconnect();
          }
        });
        observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-scene-ready', 'data-renderer-backend'] });
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      let peak = 0;
      let sampling = true;
      const samples = (async () => {
        while (sampling) {
          peak = Math.max(peak, (await cdp.send('Runtime.getHeapUsage')).usedSize);
          await delay(25);
        }
      })();
      try {
        await page.goto(url, { waitUntil: 'commit' });
        await page.waitForFunction(() => performance.getEntriesByName('replay-scene-ready').length > 0, null, { timeout: 60000 });
      } finally {
        sampling = false;
        await samples;
      }
      const readyMs = await page.evaluate(() => performance.getEntriesByName('replay-scene-ready')[0].startTime);
      await cdp.send('HeapProfiler.collectGarbage');
      const retained = (await cdp.send('Runtime.getHeapUsage')).usedSize;
      console.log(JSON.stringify({ run, readyMs, peakHeapMiB: peak / 1048576, retainedHeapMiB: retained / 1048576 }));
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
