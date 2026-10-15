import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runtime } from "../../config/runtime";

const SETTINGS_PATH = resolve(runtime.freshInstall.dataDir, "settings.json");
const destination = resolve(runtime.freshInstall.dataDir, "sessions");

type LayoutStatus = {
  directory: string;
  destinationDirectory: string | null;
  fileCount: number;
  sessionCount: number;
  progress: { status: "idle" | "partial" | "success"; phase: null; done: number; total: number; migrated: number; failed: number; error: string | null };
};

function idleStatus(): LayoutStatus {
  return { directory: destination, destinationDirectory: null, fileCount: 0, sessionCount: 0, progress: { status: "idle", phase: null, done: 0, total: 0, migrated: 0, failed: 0, error: null } };
}
function partialStatus(): LayoutStatus {
  return { directory: destination, destinationDirectory: destination, fileCount: 1, sessionCount: 1, progress: { status: "partial", phase: null, done: 1, total: 1, migrated: 0, failed: 1, error: "interrupted" } };
}
function successStatus(): LayoutStatus {
  return { directory: destination, destinationDirectory: destination, fileCount: 0, sessionCount: 1, progress: { status: "success", phase: null, done: 1, total: 1, migrated: 1, failed: 0, error: null } };
}

async function installMigrationRoutes(page: Page, initiallyFailed: boolean) {
  let failed = initiallyFailed;
  let completed = false;
  const requestedTargets: unknown[] = [];
  await page.route("**/api/storage/layout-migration", async (route) => {
    if (route.request().method() === "POST") {
      requestedTargets.push((route.request().postDataJSON() as { directory?: unknown } | null)?.directory);
      completed = true;
      await route.fulfill({ status: 202, json: { accepted: true } });
      return;
    }
    await route.fulfill({ json: completed ? successStatus() : failed ? partialStatus() : idleStatus() });
  });
  return { requestedTargets, exposeFailure: () => { failed = true; } };
}

async function startOnboarding(page: Page, initiallyFailed: boolean) {
  const originalSettings = readFileSync(SETTINGS_PATH, "utf8");
  writeFileSync(SETTINGS_PATH, JSON.stringify({ ...JSON.parse(originalSettings), udpPort: Number(runtime.freshInstall.udpPort), onboardingComplete: false }));
  const auth = await page.request.get("/api/auth/status");
  if (auth.ok() && (await auth.json() as { pending?: boolean }).pending) {
    const setup = await page.request.post("/api/auth/setup", { data: { password: null, exposureConfirmed: true } });
    expect(setup.ok()).toBe(true);
  }
  const routes = await installMigrationRoutes(page, initiallyFailed);
  await page.goto("/onboarding?welcome=true", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible();
  if (initiallyFailed) {
    await expect(page.getByRole("button", { name: /^Retry/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Get Started" })).toBeDisabled();
  } else {
    await expect(page.getByRole("button", { name: "Get Started" })).toBeEnabled();
  }
  return { ...routes, restoreSettings: () => writeFileSync(SETTINGS_PATH, originalSettings) };
}

async function reachStorage(page: Page) {
  const getStarted = page.getByRole("button", { name: "Get Started" });
  await getStarted.focus();
  await getStarted.press("Enter");
  await expect(page.getByRole("heading", { name: "Access & security" })).toBeVisible();
  const passwordGroup = page.getByRole("group", { name: "Password protection", exact: true });
  if (await passwordGroup.count()) {
    await passwordGroup.getByRole("button", { name: "Continue without a password" }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
  } else {
    await expect(page.getByRole("heading", { name: "Access & security" })).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
  }
  for (const heading of ["What's your name?", "Choose the steering wheel displayed during live telemetry.", "Units", "Sound", "Launch on Login"]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "Storage" })).toBeVisible();
}

async function retryInOnboarding(page: Page, requestedTargets: unknown[], nextButton: string) {
  await page.getByRole("button", { name: /^Retry/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Retry/ }).click();
  await expect.poll(() => requestedTargets).toEqual([destination]);
  await expect(page.getByRole("button", { name: nextButton, exact: true })).toBeEnabled();
}

test.describe("onboarding recording-layout recovery", () => {
  test("reload at Welcome exposes same-destination retry and blocks navigation until complete", async ({ page }) => {
    const fixture = await startOnboarding(page, true);
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("button", { name: /^Retry/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "Get Started" })).toBeDisabled();
      await retryInOnboarding(page, fixture.requestedTargets, "Get Started");
    } finally {
      fixture.restoreSettings();
    }
  });

  test("Storage step exposes same-destination retry", async ({ page }) => {
    const fixture = await startOnboarding(page, false);
    try {
      await reachStorage(page);
      fixture.exposeFailure();
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Retry/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
      await retryInOnboarding(page, fixture.requestedTargets, "Next");
    } finally {
      fixture.restoreSettings();
    }
  });
  test("recording folder path copy falls back when Clipboard API is absent or rejected", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const fixture = await startOnboarding(page, false);
    try {
      await reachStorage(page);
      const { directory } = await (await page.request.get("/api/storage/recording-directory")).json() as { directory: string };
      const copyPath = page.getByRole("button", { name: "Copy path", exact: true });

      await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
      await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
      await copyPath.click();
      await page.evaluate(() => Reflect.deleteProperty(navigator, "clipboard"));
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(directory);

      await page.evaluate(async () => {
        await navigator.clipboard.writeText("sentinel");
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } });
      });
      await copyPath.click();
      await page.evaluate(() => Reflect.deleteProperty(navigator, "clipboard"));
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(directory);

      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
        document.execCommand = () => false;
      });
      await copyPath.click();
      await expect(page.getByRole("alert")).toHaveText("Could not copy the link. Select the address and copy it manually.");
    } finally {
      fixture.restoreSettings();
    }
  });
});
