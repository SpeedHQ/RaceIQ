import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { startSparseSplitMigration } from "./sparse-split-migration";

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
    const deleted = await page.request.delete(`/api/tunes/${t.id}?confirmInUse=true`);
    expect(deleted.ok(), `cleanup setup ${t.id}`).toBe(true);
  }
}

/** Prepare seeded test state: persist onboarding completion, accept the one-time
 * recording-split prompt, then leave the dashboard so unrelated requests do
 * not leak into later page-specific browser-error assertions. */
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
  await startSparseSplitMigration(page);
  await page.goto("about:blank");
}

/** Common guard used by each game's spec — waits for the SetupBrowser to
 * render (loaded or empty). Localized button text is supplied by the app's
 * default UI locale, so match the stable accessible button name loosely. */
export async function waitForTunesList(page: Page) {
  await expect(page.getByRole("button", { name: /new setup/i })).toBeVisible({ timeout: 15_000 });
}
