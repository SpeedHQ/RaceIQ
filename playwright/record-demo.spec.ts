import { test } from "@playwright/test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { resolve } from "path";

/**
 * Records the RaceIQ welcome demo as 1920×1080 JPEG frames, one per packet.
 *
 * Pipeline (single pass, no video intermediate):
 *   1. Main thread: __setFrame(i) → 2 RAFs (React + R3F) → createImageBitmap(canvas)
 *      (near-zero-cost GPU→GPU copy).
 *   2. ImageBitmap posted to one of N Web Workers via structured clone + transfer.
 *   3. Worker: draws bitmap onto OffscreenCanvas → convertToBlob('image/jpeg')
 *      (browser's libjpeg-turbo, SIMD, off the main thread).
 *   4. Worker returns base64 → main thread calls __writeFrame (fire-and-forget).
 *   5. Node writes JPEG to disk in parallel with browser rendering next frame.
 *
 * JPEG encoding runs parallel to rendering, so main-thread bottleneck is just
 * the 2 RAF waits (~33ms). ~30-40ms per frame → 1800 frames in ~60-70s.
 *
 * Env:
 *   DEMO_MAX_FRAMES   max packets to record (default 1800 = 30s @ 60fps)
 *   DEMO_START_FRAME  starting packet index (default 0). Use "30%" for fractional.
 *   DEMO_FRAMES_DIR   output jpg dir (default /tmp/raceiq-demo-frames)
 */

const MAX_FRAMES = parseInt(process.env.DEMO_MAX_FRAMES ?? "1800", 10);
const START_FRAME_RAW = process.env.DEMO_START_FRAME ?? "0";
const FRAMES_DIR = resolve(process.env.DEMO_FRAMES_DIR ?? "/tmp/raceiq-demo-frames");
const WORKER_COUNT = 4;

test("record demo render", async ({ page }, testInfo) => {
  testInfo.setTimeout(0);

  if (existsSync(FRAMES_DIR)) rmSync(FRAMES_DIR, { recursive: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  // Stream frames + progress from browser → Node
  await page.exposeBinding("__writeFrame", (_, data: { idx: number; b64: string }) => {
    const padded = String(data.idx).padStart(6, "0");
    writeFileSync(`${FRAMES_DIR}/frame-${padded}.jpg`, Buffer.from(data.b64, "base64"));
  });
  await page.exposeBinding("__log", (_, msg: string) => {
    console.log(msg);
  });

  // Set recording flag before page load:
  //   - preserveDrawingBuffer: true  → createImageBitmap(canvas) gets live pixels
  //   - fps cap bypass               → every RAF triggers an R3F render
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__recording = true;
    const toggles = JSON.parse(localStorage.getItem("carwireframe-toggles") ?? "{}");
    localStorage.setItem("carwireframe-toggles", JSON.stringify({ ...toggles, inputs: true }));
  });

  // Fresh server: onboardingComplete=false → wizard shows automatically
  await page.goto("/");

  await page.waitForSelector("canvas", { timeout: 15_000 });
  await page.waitForFunction(
    () => typeof (window as unknown as Record<string, unknown>).__totalFrames === "number",
    { timeout: 10_000 },
  );

  const totalFrames: number = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__totalFrames as number,
  );
  const startFrame = START_FRAME_RAW.endsWith("%")
    ? Math.floor(totalFrames * (parseFloat(START_FRAME_RAW) / 100))
    : parseInt(START_FRAME_RAW, 10);
  const capture = Math.min(totalFrames - startFrame, MAX_FRAMES);
  console.log(`Source: ${totalFrames} packets, starting at ${startFrame}, capturing ${capture} (${(capture / 60).toFixed(1)}s at 60fps playback)`);

  // Pause, seek to start frame, stretch canvas fullscreen
  await page.evaluate((start: number) => {
    const w = window as unknown as Record<string, unknown>;
    (w.__pauseAnimation as () => void)();
    (w.__setFrame as (n: number) => void)(start);
  }, startFrame);

  await page.evaluate(() => {
    const canvas = document.querySelector("canvas")!;
    const container = (canvas.closest(".h-48") ?? canvas.parentElement) as HTMLElement;
    container.style.cssText = [
      "position:fixed", "inset:0", "width:100vw", "height:100vh",
      "z-index:9999", "background:black", "border-radius:0", "border:none", "overflow:hidden",
    ].join(";");
  });
  await page.waitForTimeout(800);

  console.log(`Rendering ${capture} frames (${WORKER_COUNT} JPEG encode workers)…`);
  const t0 = Date.now();

  await page.evaluate(async ({ captureCount, workerCount, startFrame: startFr }) => {
    const w = window as unknown as Record<string, unknown>;
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const setFrame = w.__setFrame as (n: number) => void;
    const writeFrame = w.__writeFrame as (d: { idx: number; b64: string }) => Promise<void>;
    const log = w.__log as (msg: string) => Promise<void>;

    // Worker: receives ImageBitmap, encodes JPEG on off-thread, returns base64
    const workerSrc = `
      self.onmessage = async (e) => {
        const { idx, bitmap } = e.data;
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.byteLength; i += CHUNK) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
        }
        self.postMessage({ idx, b64: btoa(binary) });
      };
    `;
    const workerUrl = URL.createObjectURL(new Blob([workerSrc], { type: "application/javascript" }));

    const inFlight = new Set<number>();
    const workers: Worker[] = [];
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(workerUrl);
      worker.onmessage = (ev: MessageEvent<{ idx: number; b64: string }>) => {
        const { idx, b64 } = ev.data;
        // Fire-and-forget write to Node; don't block render loop
        writeFrame({ idx, b64 }).catch(() => {});
        inFlight.delete(idx);
      };
      workers.push(worker);
    }

    const MAX_IN_FLIGHT = workerCount * 3;

    // Log GPU renderer info
    try {
      const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
      if (gl) {
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
        const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : "unknown";
        await log(`  WebGL: ${vendor} / ${renderer}`);
      }
    } catch { /* noop */ }

    let tRaf = 0, tBitmap = 0, tPost = 0;

    for (let i = 0; i < captureCount; i++) {
      const t0 = performance.now();
      setFrame(startFr + i);
      // Two RAFs: React state commit, then R3F render
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const t1 = performance.now();

      // GPU canvas → ImageBitmap (fast GPU copy)
      const bitmap = await createImageBitmap(canvas);
      const t2 = performance.now();

      inFlight.add(i);
      workers[i % workerCount].postMessage({ idx: i, bitmap }, [bitmap]);
      const t3 = performance.now();

      tRaf += t1 - t0;
      tBitmap += t2 - t1;
      tPost += t3 - t2;

      // Back-pressure: don't let too many frames queue in workers
      while (inFlight.size > MAX_IN_FLIGHT) {
        await new Promise((r) => setTimeout(r, 1));
      }

      if (i % 50 === 49) {
        const n = i + 1;
        await log(`  frame ${n}/${captureCount}  rafs=${(tRaf / n).toFixed(0)}ms bitmap=${(tBitmap / n).toFixed(0)}ms post=${(tPost / n).toFixed(0)}ms`);
      }
    }

    // Drain remaining workers
    while (inFlight.size > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }

    workers.forEach((wk) => wk.terminate());
    URL.revokeObjectURL(workerUrl);
  }, { captureCount: capture, workerCount: WORKER_COUNT, startFrame });

  const elapsed = (Date.now() - t0) / 1000;
  console.log(`Done in ${elapsed.toFixed(1)}s (${(capture / elapsed).toFixed(1)} fps capture) → ${FRAMES_DIR}`);
});
