import type { Browser, Page } from "@playwright/test";

const STORY_ROOT_CHILD = "#storybook-root > *";

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
