import type { Browser, Page } from "@playwright/test";

const STORY_ROOT_CHILD = "#storybook-root > *";
const REQUIRED_THEME_TOKENS = ["--app-bg", "--app-text", "--app-accent", "--font-sans", "--font-mono"];
const SNAPSHOT_STYLE = `
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

interface WarmStorybookOptions {
  attempts?: number;
  attemptTimeoutMs?: number;
}

/**
 * Open one Storybook story and wait for actual story content.
 *
 * Storybook's iframe shell can report `load` while its preview still shows
 * `sb-preparing-story`. Waiting on `#storybook-root` avoids treating manager
 * chrome or a coincidental component class as story readiness.
 */
export async function openStory(page: Page, storyUrl: string, timeoutMs = 60_000): Promise<void> {
  await page.goto(storyUrl, { waitUntil: "domcontentloaded" });
  await page.locator(STORY_ROOT_CHILD).first().waitFor({ state: "visible", timeout: timeoutMs });
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

async function visualStateSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.querySelector("#storybook-root");
    if (!root) return "missing-root";

    let hash = 2166136261;
    const add = (value: string | number) => {
      const text = String(value);
      for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    };

    for (const element of [root, ...root.querySelectorAll("*")]) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      add(element.tagName);
      add(Math.round(rect.x * 100));
      add(Math.round(rect.y * 100));
      add(Math.round(rect.width * 100));
      add(Math.round(rect.height * 100));
      add(style.backgroundColor);
      add(style.color);
      add(style.fill);
      add(style.opacity);
      add(style.stroke);
      add(style.transform);
    }

    for (const canvas of root.querySelectorAll("canvas")) {
      add(canvas.width);
      add(canvas.height);
      try {
        add(canvas.toDataURL("image/png"));
      } catch {
        add("unreadable-canvas");
      }
    }

    return (hash >>> 0).toString(16);
  });
}

async function waitForStableVisualState(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let stableSamples = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const current = await visualStateSignature(page);
    stableSamples = current === previous ? stableSamples + 1 : 0;
    if (stableSamples >= 2) return;
    previous = current;
  }

  throw new Error(`Storybook visual state did not settle within ${timeoutMs}ms`);
}

/**
 * Open a story in deterministic visual-test mode and wait for renderers.
 *
 * Snapshot mode is installed before navigation, so CSS transitions and
 * JavaScript reduced-motion branches never begin in a random phase. After
 * fonts and theme variables resolve, a one-pixel viewport pulse forces
 * ResizeObserver-backed charts and fit-to-viewport layouts to redraw. The
 * final stability loop includes DOM geometry, computed paint styles, and 2D
 * canvas pixels.
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
  await waitForStableVisualState(page, timeoutMs);
}

/**
 * Pay Storybook's cold preview compilation once before snapshot tests.
 *
 * Storybook 10 can leave its first preview navigation in
 * `sb-preparing-story` after the dev server index becomes available. Reloading
 * the iframe retries story preparation against the now-built preview graph.
 */
export async function warmStorybook(browser: Browser, storyUrl: string, { attempts = 12, attemptTimeoutMs = 10_000 }: WarmStorybookOptions = {}): Promise<void> {
  const page = await browser.newPage();
  let lastError: unknown;

  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await openStory(page, storyUrl, attemptTimeoutMs);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`Storybook never rendered ${storyUrl} after ${attempts} attempts`, { cause: lastError });
  } finally {
    await page.close();
  }
}
