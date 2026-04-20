import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Clear existing tunes before each spec by hitting the REST API directly —
 *  the Playwright webServer brings up a real Hono server with its own
 *  temporary DATA_DIR, so this only affects the test database. */
export async function resetTunes(page: Page) {
  const list = await page.request.get(`/api/tunes`);
  if (!list.ok()) return;
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
  if (!res.ok()) return;
  const settings = await res.json();
  if (settings.onboardingComplete) return;
  await page.request.put(`/api/settings`, {
    data: { ...settings, onboardingComplete: true },
  });
}

/** Common guard used by each game's spec — waits for the "My Tunes" list to
 *  render (loaded or empty), never the loading spinner. */
export async function waitForTunesList(page: Page, label: string) {
  const heading = page.getByRole("heading", { name: label });
  await expect(heading).toBeVisible({ timeout: 15_000 });
}
