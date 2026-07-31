import { expect, type Page, test } from "@playwright/test";
import { RESPONSIVE_INTERACTION_CASES, RESPONSIVE_PAGES, RESPONSIVE_VIEWPORTS } from "./responsive-screenshot-cases";

// Responsive screenshot tests.
//
// Runs against the fresh-install webServer with isolated DATA_DIR. Screenshot
// workflows load committed demo fixtures; ad-hoc unseeded runs retain their
// smaller shell-only coverage.
//
// Inventory covers representative high-risk screens at phone, tablet boundary,
// and desktop widths. Structural route reachability and extra breakpoint edges
// remain in responsive-workspaces.spec.ts so screenshot count stays bounded.
//
// Output: playwright/screenshots/mobile/<viewport>/<page>.png (gitignored).

const SCREENSHOT_DIR = process.env.RACEIQ_SCREENSHOT_DIR ?? "./screenshots/mobile";
const SEEDED_SCREENSHOTS = process.env.PW_SEED_SCREENSHOTS === "1";

async function openSettings(page: Page, viewportWidth: number) {
  if (viewportWidth < 768) {
    await page.getByLabel("Open navigation").click();
  }
  await page.getByRole("button", { name: /Settings|TestDriver/ }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
}

if (!SEEDED_SCREENSHOTS) {
  test.beforeAll(async ({ request }) => {
    // Unseeded ad-hoc runs still need app chrome. Seeded runs already persist
    // onboardingComplete and skip this shared write so tests can run parallel.
    const res = await request.put("/api/settings", {
      data: { onboardingComplete: true, driverName: "TestDriver" },
    });
    expect(res.ok()).toBeTruthy();
  });
}

for (const viewport of RESPONSIVE_VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const page of RESPONSIVE_PAGES) {
      if (page.viewports && !page.viewports.includes(viewport.name)) continue;
      if (page.requiresSeed && !SEEDED_SCREENSHOTS) continue;

      test(page.name, async ({ page: p }) => {
        await p.goto(page.path, { waitUntil: "networkidle" });
        await expect(p.locator("[data-responsive-workspace]")).toBeVisible();
        if (page.readyText) {
          await expect(p.getByText(page.readyText, { exact: false }).first()).toBeVisible();
        }
        if (page.seedReadyText && SEEDED_SCREENSHOTS) {
          await expect(p.getByText(page.seedReadyText, { exact: false }).first()).toBeVisible();
        }
        await p.waitForTimeout(500);
        await p.screenshot({
          path: `${SCREENSHOT_DIR}/${viewport.name}/${page.name}.png`,
          fullPage: true,
          animations: "disabled",
        });
      });
    }

    for (const screenshotCase of RESPONSIVE_INTERACTION_CASES) {
      if (screenshotCase.mobileOnly && viewport.width >= 768) continue;

      test(screenshotCase.name, async ({ page: p }) => {
        await p.goto(screenshotCase.path, { waitUntil: "networkidle" });
        if (screenshotCase.kind === "nav-drawer") {
          await p.getByLabel("Open navigation").click();
          await expect(p.getByRole("navigation").last()).toBeVisible();
        } else if (screenshotCase.kind === "settings") {
          await openSettings(p, viewport.width);
        } else if (screenshotCase.kind === "settings-language") {
          await openSettings(p, viewport.width);
          await p.getByRole("combobox").click();
          await expect(p.getByRole("listbox", { name: "Search language..." })).toBeVisible();
        } else {
          await p.getByRole("button", { name: "Export / Import" }).click();
          await expect(p.getByRole("menu")).toBeVisible();
        }
        await p.waitForTimeout(200);
        await p.screenshot({
          path: `${SCREENSHOT_DIR}/${viewport.name}/${screenshotCase.name}.png`,
          fullPage: false,
          animations: "disabled",
        });
      });
    }
  });
}
