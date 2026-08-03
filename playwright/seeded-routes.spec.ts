import { expect, test, type Page } from "@playwright/test";

import {
  SEEDED_GAME_CASES,
  SEEDED_GLOBAL_ROUTE_CASES,
  SEEDED_ROUTE_CASES,
  type SeededFeature,
} from "./seeded-e2e-cases";
import { collectBrowserErrors } from "./seeded-e2e-helpers";

async function assertNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        const workspace = document.querySelector<HTMLElement>("[data-responsive-workspace]");
        return (
          root.scrollWidth <= root.clientWidth + 1 &&
          workspace !== null &&
          workspace.scrollWidth <= workspace.clientWidth + 1
        );
      }),
    )
    .toBe(true);
}

const ROUTE_ERROR_TEXT = [
  /desktop required/i,
  /\bnot found\b/i,
  /\broute error\b/i,
];

async function assertNoRouteErrors(page: Page) {
  for (const text of ROUTE_ERROR_TEXT) {
    await expect(page.getByText(text)).toHaveCount(0);
  }
}

async function assertHealthySeededRoute(page: Page, trackHeading?: string) {
  const workspace = page.locator("[data-responsive-workspace]");
  await expect(workspace).toHaveCount(1, { timeout: 15_000 });
  await expect(workspace).toBeVisible();
  await assertNoRouteErrors(page);
  await assertNoHorizontalOverflow(page);

  if (trackHeading) {
    await expect(page.getByText(trackHeading, { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });
  }
}

for (const route of SEEDED_GLOBAL_ROUTE_CASES) {
  test(`Global — ${route.label} (${route.path})`, async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    await page.goto(route.path, { waitUntil: "domcontentloaded" });
    await assertHealthySeededRoute(page);
    expect(browserErrors.errors, `unexpected browser errors on ${route.path}`).toEqual([]);
  });
}

for (const route of SEEDED_ROUTE_CASES) {
  test(`${route.game.name} — ${route.label} (${route.path})`, async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    await page.goto(route.path, { waitUntil: "domcontentloaded" });
    if (route.expectedPath) {
      await expect(page).toHaveURL(new RegExp(`${route.expectedPath.replaceAll("/", "\\/")}\\/?$`));
    }
    await assertHealthySeededRoute(page, route.trackHeading);
    expect(browserErrors.errors, `unexpected browser errors on ${route.path}`).toEqual([]);
  });
}

const UNSUPPORTED_NAV_LABELS: Partial<Record<SeededFeature, string>> = {
  driver: "Driver",
  experiments: "Experiments",
  setups: "Setups",
};

for (const game of SEEDED_GAME_CASES.filter(
  ({ unsupportedFeatures }) => unsupportedFeatures.length > 0,
)) {
  test(`${game.name} hides unsupported features`, async ({ page }) => {
    await page.goto(`/${game.prefix}`, { waitUntil: "domcontentloaded" });
    const navigation = page.getByRole("navigation", { name: "Navigation" });
    await expect(navigation).toBeVisible();
    for (const feature of game.unsupportedFeatures) {
      const label = UNSUPPORTED_NAV_LABELS[feature];
      if (!label) {
        throw new Error(`Missing unsupported navigation assertion for ${feature}`);
      }
      await expect(
        navigation.getByRole("link", { name: label, exact: true }),
      ).toHaveCount(0);
    }
  });
}
