import type { Page } from "@playwright/test";

const STORY_ROOT_CHILD = "#storybook-root > *";
const REQUIRED_THEME_TOKENS = ["--app-bg", "--app-text", "--app-accent", "--font-sans", "--font-mono"];
const SNAPSHOT_STYLE = `
  html[data-visual-test] [data-visual-test-hidden] {
    visibility: hidden !important;
  }
  html[data-visual-test] *,
  html[data-visual-test] *::before,
  html[data-visual-test] *::after {
    animation-delay: 0s !important;
    animation-duration: 0s !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
    transition-delay: 0s !important;
    transition-duration: 0s !important;
  }
`;

/**
 * Open one Storybook story and wait for actual story content.
 *
 * Storybook's iframe shell can report `load` while its preview still shows
 * `sb-preparing-story`. Waiting on `#storybook-root` avoids treating manager
 * chrome or a coincidental component class as story readiness.
 */
export async function openStory(page: Page, storyUrl: string, timeoutMs = 60_000): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(storyUrl, { waitUntil: "commit", timeout: timeoutMs });
      await page.locator(`${STORY_ROOT_CHILD}, .sb-errordisplay`).filter({ visible: true }).first().waitFor({ state: "visible", timeout: timeoutMs });
    } catch (error) {
      lastError = error;
      continue;
    }
    const storyError = page.locator(".sb-errordisplay");
    if (await storyError.isVisible()) {
      throw new Error(`Storybook failed to render ${storyUrl}: ${await storyError.locator("h1").textContent()}`);
    }
    return;
  }
  throw lastError;
}

async function installSnapshotMode(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript((snapshotStyle) => {
    const install = () => {
      document.documentElement.dataset.visualTest = "true";
      const style = document.createElement("style");
      style.dataset.visualTestStyle = "true";
      style.textContent = snapshotStyle;
      document.documentElement.append(style);
    };

    if (document.documentElement) install();
    else document.addEventListener("DOMContentLoaded", install, { once: true });
  }, SNAPSHOT_STYLE);
}
async function waitForStableCanvases(page: Page, timeoutMs: number): Promise<void> {
  const settled = await page.evaluate(async (timeout) => {
    const deadline = Date.now() + timeout;
    let previous = new Map<HTMLCanvasElement, { width: number; height: number; ready: boolean; pixels: Uint8ClampedArray | null }>();
    const scratch = document.createElement("canvas");
    let scratchContext: CanvasRenderingContext2D | null = null;
    let previousCanvases: HTMLCanvasElement[] = [];
    let stableSamples = 0;

    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const canvases = Array.from(document.querySelectorAll("canvas"));
      let unchanged = canvases.length === previousCanvases.length;
      for (let index = 0; unchanged && index < canvases.length; index += 1) {
        unchanged = canvases[index] === previousCanvases[index];
      }

      const current = new Map<HTMLCanvasElement, { width: number; height: number; ready: boolean; pixels: Uint8ClampedArray | null }>();
      for (const canvas of canvases) {
        const marker = canvas.closest("[data-visual-ready]");
        const ready = marker?.getAttribute("data-visual-ready") === "ready";
        const before = previous.get(canvas);
        if (ready) {
          current.set(canvas, { width: canvas.width, height: canvas.height, ready, pixels: null });
          if (!before || before.width !== canvas.width || before.height !== canvas.height || !before.ready) unchanged = false;
          continue;
        }
        if (marker) unchanged = false;

        let pixels: Uint8ClampedArray | null = null;
        if (canvas.width > 0 && canvas.height > 0) {
          try {
            if (scratch.width !== canvas.width) scratch.width = canvas.width;
            if (scratch.height !== canvas.height) scratch.height = canvas.height;
            scratchContext ??= scratch.getContext("2d", { willReadFrequently: true });
            if (scratchContext) {
              scratchContext.clearRect(0, 0, canvas.width, canvas.height);
              scratchContext.drawImage(canvas, 0, 0);
              pixels = scratchContext.getImageData(0, 0, canvas.width, canvas.height).data;
            }
          } catch {
            pixels = null;
            scratch.width = 0;
            scratchContext = null;
          }
        }

        let equal = Boolean(before && before.width === canvas.width && before.height === canvas.height && !before.ready);
        if (equal && before!.pixels === null && pixels === null) {
          // Unreadable canvases retain prior dimensions-only stability semantics.
        } else if (equal && before!.pixels && pixels && before!.pixels.length === pixels.length) {
          const oldPixels = before!.pixels;
          for (let pixel = 0; pixel < pixels.length; pixel += 1) {
            if (pixels[pixel] !== oldPixels[pixel]) {
              equal = false;
              break;
            }
          }
        } else {
          equal = false;
        }
        if (!equal) unchanged = false;
        current.set(canvas, { width: canvas.width, height: canvas.height, ready, pixels });
      }

      if (unchanged) stableSamples += 1;
      else stableSamples = 0;
      if (stableSamples >= 2) return true;
      previousCanvases = canvases;
      previous = current;
    }
    return false;
  }, timeoutMs);
  if (!settled) throw new Error(`Storybook canvas state did not settle within ${timeoutMs}ms`);
}

/**
 * Wait for story-specific renderers to finish deterministic visual setup.
 *
 * Called after Storybook interaction tests have had a chance to run. Waiting
 * before play functions complete can deadlock stories whose final visual state
 * is marked ready by their play function.
 */
export async function waitForVisualReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.waitForFunction(() => Array.from(document.querySelectorAll("[data-visual-ready]")).every((element) => element.getAttribute("data-visual-ready") === "ready"), undefined, {
    timeout: timeoutMs,
  });
  await waitForStableCanvases(page, timeoutMs);
}

/**
 * Open one story in deterministic visual-test mode.
 *
 * Most stories wait for readiness before assertions. Stories whose Storybook
 * play function marks readiness must pass `waitForReady=false`, then wait after
 * navigation so readiness cannot deadlock play.
 */
export async function openStoryForSnapshot(page: Page, storyUrl: string, timeoutMs = 60_000, waitForReady = true): Promise<void> {
  await installSnapshotMode(page);
  await openStory(page, storyUrl, timeoutMs);

  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    (tokens) => {
      const style = getComputedStyle(document.documentElement);
      return tokens.every((token) => style.getPropertyValue(token).trim().length > 0);
    },
    REQUIRED_THEME_TOKENS,
    { timeout: timeoutMs },
  );
  await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0), undefined, { timeout: timeoutMs });

  const viewport = page.viewportSize();
  if (viewport) {
    await page.setViewportSize({ width: viewport.width + 1, height: viewport.height });
    await page.setViewportSize(viewport);
  }
  if (waitForReady) await waitForVisualReady(page, timeoutMs);
}
