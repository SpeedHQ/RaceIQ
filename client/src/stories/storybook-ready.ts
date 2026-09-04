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
      await page.locator(STORY_ROOT_CHILD).first().waitFor({ state: "visible", timeout: timeoutMs });
      return;
    } catch (error) {
      lastError = error;
    }
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
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let stableSamples = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(50);
    const current = await page.evaluate(() =>
      Array.from(document.querySelectorAll("canvas"))
        .map((canvas) => {
          try {
            return `${canvas.width}x${canvas.height}:${canvas.toDataURL("image/png")}`;
          } catch {
            return `${canvas.width}x${canvas.height}:unreadable`;
          }
        })
        .join("|"),
    );
    stableSamples = current === previous ? stableSamples + 1 : 0;
    if (stableSamples >= 2) return;
    previous = current;
  }

  throw new Error(`Storybook canvas state did not settle within ${timeoutMs}ms`);
}

/**
 * Open a story in deterministic visual-test mode and wait for renderers.
 *
 * Snapshot mode is installed before navigation, so CSS transitions and
 * JavaScript reduced-motion branches never begin in a random phase. After
 * fonts and theme variables resolve, a one-pixel viewport pulse forces
 * ResizeObserver-backed charts and fit-to-viewport layouts to redraw.
 */
export async function openStoryForSnapshot(page: Page, storyUrl: string, timeoutMs = 60_000): Promise<void> {
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

  await page.waitForFunction(() => Array.from(document.querySelectorAll("[data-visual-ready]")).every((element) => element.getAttribute("data-visual-ready") === "ready"), undefined, {
    timeout: timeoutMs,
  });
  await waitForStableCanvases(page, timeoutMs);
}
