import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Clear existing tunes before each spec by hitting the REST API directly —
 *  the Playwright webServer brings up a real Hono server with its own
 *  temporary DATA_DIR, so this only affects the test database. */
export async function resetTunes(page: Page) {
  const list = await page.request.get(`/api/tunes`);
  if (!list.ok()) {
    throw new Error(`resetTunes: GET ${list.url()} failed with status ${list.status()}`);
  }
  const rows = (await list.json()) as { id: number }[];
  for (const t of rows) {
    await page.request.delete(`/api/tunes/${t.id}`);
  }
}

/** Dismiss the onboarding modal if it's shown on first visit — the test DB
 *  starts empty, so the first page load triggers it. We persist `settings`
 *  via the REST API so subsequent navigations skip the modal. */
export async function completeOnboarding(page: Page) {
  // Fastest path: write settings directly rather than clicking through the
  // onboarding UI (which varies between wheel pickers, units, etc.).
  const res = await page.request.get(`/api/settings`);
  if (!res.ok()) {
    throw new Error(`completeOnboarding: GET ${res.url()} failed with status ${res.status()}`);
  }
  const settings = await res.json();
  if (settings.onboardingComplete) return;
  await page.request.put(`/api/settings`, {
    data: { ...settings, onboardingComplete: true },
  });
}

/** Common guard used by each game's spec — waits for the SetupBrowser to
 *  render (loaded or empty). Anchors on the "+ New tune" button since the
 *  page title heading was dropped in the SetupBrowser rewrite; the button is
 *  present for FM23 / ACC / AC-EVO alike. */
export async function waitForTunesList(page: Page) {
  await expect(page.getByRole("button", { name: /\+ New tune/i })).toBeVisible({ timeout: 15_000 });
}
