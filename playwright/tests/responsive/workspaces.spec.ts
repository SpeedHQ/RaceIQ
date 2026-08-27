import { expect, test, type Page } from "@playwright/test";
import { assertNoHorizontalOverflow } from "../support/responsive/assertions";
const VIEWPORTS = [
  { name: "minimum", width: 320, height: 568 },
  { name: "phone", width: 390, height: 844 },
  { name: "shell-boundary-narrow", width: 767, height: 900 },
  { name: "tablet-portrait", width: 768, height: 1024 },
  { name: "square", width: 900, height: 900 },
  { name: "tablet-landscape", width: 1024, height: 768 },
  { name: "wide-short", width: 1180, height: 600 },
  { name: "workspace-wide-short", width: 1232, height: 600 },
  { name: "workspace-wide-before", width: 1231, height: 800 },
  { name: "workspace-wide", width: 1232, height: 800 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

const PAGES = [
  { name: "analyse", path: "/fm23/analyse", testId: "lap-analyse-workspace", inputCount: 3 },
  { name: "compare", path: "/fm23/compare", testId: "lap-compare-workspace", inputCount: 5 },
] as const;

const APP_ROUTES = [
  { name: "global home", path: "/" },
  { name: "game home", path: "/fm23" },
  { name: "live", path: "/fm23/live" },
  { name: "sessions", path: "/fm23/sessions" },
  { name: "tracks", path: "/fm23/tracks" },
  { name: "track detail", path: "/fm23/tracks/5/info" },
  { name: "cars", path: "/fm23/cars" },
  { name: "chats", path: "/fm23/chats" },
  { name: "driver", path: "/fm23/driver" },
  { name: "experiments", path: "/f125/experiments" },
  { name: "raw telemetry", path: "/fm23/raw" },
  { name: "Forza setups", path: "/fm23/setups" },
  { name: "ACC setups", path: "/acc/setups" },
  { name: "portable catalogue", path: "/portable" },
  { name: "standalone portable dashboard", path: "/portable/combo-1" },
  { name: "developer tools", path: "/dev" },
] as const;

const APP_VIEWPORTS = [
  { name: "minimum", width: 320, height: 568 },
  { name: "square", width: 900, height: 900 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

async function assertAppRouteShell(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  const workspace = page.locator("[data-responsive-workspace]");
  await expect(workspace).toHaveCount(1, { timeout: 15_000 });
  await expect(workspace).toBeVisible();
  await expect(page.getByText("Desktop required")).toHaveCount(0);
  await expect(page.getByText("Rotate your device")).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
}

async function assertInputsInsideViewport(page: Page, testId: string, expectedCount: number) {
  const inputs = page.getByTestId(testId).locator('input[type="text"]');
  await expect(inputs).toHaveCount(expectedCount);

  for (let index = 0; index < expectedCount; index++) {
    const input = inputs.nth(index);
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeVisible();
    const box = await input.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
}

test.beforeAll(async ({ request }) => {
  const response = await request.put("/api/settings", {
    data: { onboardingComplete: true, driverName: "ResponsiveTest" },
  });
  expect(response.ok()).toBeTruthy();
});

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const target of PAGES) {
      test(`${target.name} remains reachable`, async ({ page }) => {
        await page.goto(target.path, { waitUntil: "networkidle" });
        await expect(page.getByTestId(target.testId)).toBeVisible();
        await expect(page.getByText("Desktop required")).toHaveCount(0);
        await expect(page.getByText("Rotate your device")).toHaveCount(0);
        await assertInputsInsideViewport(page, target.testId, target.inputCount);
        await assertNoHorizontalOverflow(page);

        const firstInput = page.getByTestId(target.testId).locator('input[type="text"]').first();
        await firstInput.click();
        await expect(firstInput).toBeFocused();
        await assertNoHorizontalOverflow(page);
      });
    }
  });
}

for (const viewport of APP_VIEWPORTS) {
  test(`app routes follow workspace policy at ${viewport.name} ${viewport.width}x${viewport.height}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    for (const route of APP_ROUTES) {
      await test.step(route.name, async () => {
        await assertAppRouteShell(page, route.path);
      });
    }
  });
}
