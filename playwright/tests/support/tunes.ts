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
  // The settings endpoint merges partial updates server-side. Avoid a
  // preliminary GET: on Windows, loading settings also queries launch-on-login
  // state and can exceed Playwright's short request timeout on CI runners.
  const res = await page.request.put(`/api/settings`, {
    data: { onboardingComplete: true },
    timeout: 60_000,
  });
  if (!res.ok()) {
    throw new Error(`completeOnboarding: PUT ${res.url()} failed with status ${res.status()}`);
  }
}

/** Common guard used by each game's spec — waits for the SetupBrowser to
 *  render (loaded or empty). Anchors on the "+ New tune" button since the
 *  page title heading was dropped in the SetupBrowser rewrite; the button is
 *  present for FM23 / ACC / AC-EVO alike. */
export async function waitForTunesList(page: Page) {
  await expect(page.getByRole("button", { name: /\+ New tune/i })).toBeVisible({ timeout: 15_000 });
}
