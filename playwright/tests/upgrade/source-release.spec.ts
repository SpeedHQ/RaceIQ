import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createSourceUpgradeHarness } from "../../support/upgrade/source-release";

async function upgradeStep<T>(name: string, action: () => Promise<T>): Promise<T> {
  console.log(`[upgrade] START ${name}`);
  const result = await test.step(name, action);
  console.log(`[upgrade] DONE ${name}`);
  return result;
}

async function completeAccessSetup(page: Page, request: APIRequestContext, baseURL: string, apiURL: string, previousRelease = false) {
  const response = await request.get(`${apiURL}/api/auth/status`);
  // The published pre-auth release has no access-setup endpoint.
  if (previousRelease && response.status() === 404) return;
  expect(response.ok(), "dashboard access status").toBe(true);
  const status = await response.json() as { pending: boolean };
  if (!status.pending) return;

  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  const protection = page.getByRole("group", { name: "Password protection", exact: true });
  await expect(protection, "existing installation opens upgrade access setup").toBeVisible();
  await protection.getByRole("button", { name: "Continue without a password", exact: true }).click();
  const accepted = page.waitForResponse((result) => result.url().endsWith("/api/auth/setup") && result.request().method() === "POST");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  expect((await accepted).ok(), "access setup succeeds through the UI").toBe(true);
  await expect.poll(async () => {
    const current = await request.get(`${apiURL}/api/auth/status`);
    expect(current.ok()).toBe(true);
    return (await current.json() as { pending: boolean }).pending;
  }).toBe(false);
}

async function completeOnboarding(page: Page, request: APIRequestContext, baseURL: string, apiURL: string) {
  const completed = async () => {
    const response = await request.get(`${apiURL}/api/settings`);
    expect(response.ok(), "released settings are readable").toBe(true);
    return (await response.json() as { onboardingComplete: boolean }).onboardingComplete;
  };
  // The released seed command normally marks the existing user's setup complete.
  if (await completed()) return;
  await page.goto(`${baseURL}/onboarding?welcome=true`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Get Started", exact: true }).click();
  for (let step = 0; step < 14 && !await completed(); step++) {
    const before = await page.locator("body").innerText();
    await page.getByRole("button", { name: /^(Next|Finish)$/ }).first().click();
    await expect.poll(async () => await completed() || (await page.locator("body").innerText()) !== before).toBe(true);
  }
  expect(await completed(), "released onboarding is complete before updating").toBe(true);
}

async function completeReleasedConversion(page: Page, request: APIRequestContext, baseURL: string, apiURL: string) {
  const response = await request.get(`${apiURL}/api/sessions/capture-migration-status`);
  // Later releases have already removed the legacy converter.
  if (response.status() === 404) return;
  expect(response.ok(), "released capture conversion status").toBe(true);
  const initial = await response.json() as { captureCount: number };
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  if (initial.captureCount === 0) return;

  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Convert old recordings", exact: true }) });
  await expect(dialog, "old release prompts for conversion").toBeVisible({ timeout: 60_000 });
  const accepted = page.waitForResponse((result) => result.url().endsWith("/api/sessions/migrate-captures") && result.request().method() === "POST", { timeout: 5 * 60_000 });
  await dialog.getByRole("button", { name: "Convert", exact: true }).click();
  const result = await accepted;
  expect(result.ok(), "released conversion request succeeds").toBe(true);
  const outcome = await result.json() as { failed: number; results?: Array<{ error?: string }> };
  const errors = outcome.results?.map((item) => item.error ?? "").filter(Boolean).join("\n").slice(0, 4_000) ?? "";
  expect(outcome.failed, `released conversion failed: ${errors}`).toBe(0);
  await expect.poll(async () => {
    const current = await request.get(`${apiURL}/api/sessions/capture-migration-status`);
    expect(current.ok()).toBe(true);
    const status = await current.json() as { captureCount: number; migrationProgress: { status: string; failed: number } };
    return status.captureCount === 0 && status.migrationProgress.status === "success" && status.migrationProgress.failed === 0;
  }, { timeout: 5 * 60_000 }).toBe(true);
  const success = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: /^Conversion complete:/ }) });
  await expect(success, "released conversion shows success").toBeVisible();
  await success.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog"), "released dialogs are complete before updating").toHaveCount(0);
}

async function completeOrganization(page: Page, request: APIRequestContext, baseURL: string, apiURL: string, options: { previousRelease?: boolean; requirePending?: boolean } = {}) {
  const response = await request.get(`${apiURL}/api/storage/layout-migration`);
  if (options.previousRelease && response.status() === 404) return false;
  expect(response.ok(), "new version exposes recording migration status").toBe(true);
  const initial = await response.json() as { fileCount: number; progress: { status: string } };
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  if (options.requirePending) {
    expect(initial.fileCount, "old release lacked organization, so its recordings require the new popup").toBeGreaterThan(0);
  }
  if (initial.fileCount === 0) {
    expect(["idle", "success"]).toContain(initial.progress.status);
    await expect(page.getByRole("dialog"), "no recording migration is pending").toHaveCount(0);
    return true;
  }

  const dialog = page.getByRole("dialog", { name: "Organize your recordings", exact: true });
  await expect(dialog, "new version prompts for recording migration").toBeVisible({ timeout: 60_000 });
  const accepted = page.waitForResponse((result) => result.url().endsWith("/api/storage/layout-migration") && result.request().method() === "POST");
  await dialog.getByRole("button", { name: "Organize recordings", exact: true }).click();
  expect((await accepted).status(), "migration consent is accepted").toBe(202);
  await expect.poll(async () => {
    const current = await request.get(`${apiURL}/api/storage/layout-migration`);
    expect(current.ok()).toBe(true);
    const status = await current.json() as { fileCount: number; progress: { status: string; failed: number } };
    return status.fileCount === 0 && status.progress.status === "success" && status.progress.failed === 0;
  }, { timeout: 5 * 60_000 }).toBe(true);
  const success = page.getByRole("dialog", { name: "Recordings organized", exact: true });
  await expect(success, "new migration shows success").toBeVisible();
  await success.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog"), "upgrade dialogs are complete").toHaveCount(0);
  return true;
}

test("released data upgrades through the required popup dialogs", async ({ page, request }) => {
  const harness = await createSourceUpgradeHarness();
  try {
    await upgradeStep("Check out latest published release", () => harness.checkoutPrevious());
    await upgradeStep("Install release dependencies, migrate and seed database", () => harness.seedPrevious());
    await upgradeStep("Start released application", () => harness.start());
    const previouslyOrganized = await upgradeStep("Complete all released-version setup and migration dialogs", async () => {
      await completeAccessSetup(page, request, harness.baseURL, harness.apiURL, true);
      await completeOnboarding(page, request, harness.baseURL, harness.apiURL);
      await completeReleasedConversion(page, request, harness.baseURL, harness.apiURL);
      const organized = await completeOrganization(page, request, harness.baseURL, harness.apiURL, { previousRelease: true });
      await expect(page.getByRole("dialog"), "all released-version dialogs are complete before updating").toHaveCount(0);
      return organized;
    });
    const games = ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing", "lmu"];
    const existingIDsByGame = new Map<string, number[]>();
    for (const game of games) {
      const before = await request.get(`${harness.apiURL}/api/sessions?gameId=${game}`);
      expect(before.ok(), `${game} released sessions are readable`).toBe(true);
      const ids = (await before.json() as Array<{ id: number }>).map((session) => session.id).sort((a, b) => a - b);
      expect(ids.length, `${game} baseline contains seeded sessions`).toBeGreaterThan(0);
      existingIDsByGame.set(game, ids);
      console.log(`[upgrade] ${game} baseline contains ${ids.length} sessions`);
    }

    await page.goto("about:blank");
    await harness.stop();
    await upgradeStep("Validate released converted recordings before checkout", () => harness.validateConvertedCaptures());
    await upgradeStep("Check out latest origin/main and install dependencies", () => harness.checkoutMain());
    await upgradeStep("Start main against released database and run migrations", () => harness.start());
    await upgradeStep("Complete upgrade setup and recording migration dialogs", async () => {
      await completeAccessSetup(page, request, harness.baseURL, harness.apiURL);
      await completeOrganization(page, request, harness.baseURL, harness.apiURL, { requirePending: !previouslyOrganized });
    });
    await upgradeStep("Wait for main startup reconciliation", async () => {
      // No public startup-status endpoint exists; use the worker's terminal readiness/error signal.
      const terminal = /\[StartupWorker\].*(?:Starting dashboard processor|failed:)/;
      await expect.poll(() => terminal.test(harness.logs()), {
        message: "startup reconciliation finishes before declaring upgrade successful",
        timeout: 5 * 60_000,
      }).toBe(true);
      expect(harness.logs(), "all startup reconciliation stages succeed").toContain("[StartupWorker] Starting dashboard processor");
      expect(harness.logs(), "startup worker reports no failed stage").not.toMatch(/\[StartupWorker\].*failed:/);
    });
    await upgradeStep("Verify upgraded application and preserved sessions", async () => {
      await expect(page.getByRole("link", { name: "Home", exact: true }), "upgraded app is usable after closing dialogs").toBeVisible();
      for (const [game, existingIDs] of existingIDsByGame) {
        const after = await request.get(`${harness.apiURL}/api/sessions?gameId=${game}`);
        expect(after.ok(), `${game} upgraded sessions are readable`).toBe(true);
        expect((await after.json() as Array<{ id: number }>).map((session) => session.id).sort((a, b) => a - b), `${game} session IDs survive upgrade`).toEqual(existingIDs);
        console.log(`[upgrade] ${game} preserved ${existingIDs.length} sessions`);
      }
    });
  } finally {
    await harness.dispose();
  }
});
