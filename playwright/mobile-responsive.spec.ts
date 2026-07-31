import { test, expect } from "@playwright/test";
import {
  RESPONSIVE_INTERACTION_CASES,
  RESPONSIVE_PAGES,
  RESPONSIVE_VIEWPORTS,
} from "./responsive-screenshot-cases";

// Mobile responsive screenshot tests.
//
// Runs against the fresh-install webServer (compiled binary with isolated
// DATA_DIR, seeded with udpPort only). This spec PUTs onboardingComplete=true
// before the first navigation so the wizard doesn't block every page.
//
// Pages that are designed for big screens (live telemetry, compare, analyse)
// are deliberately excluded — the purpose is to verify that the *non-deferred*
// pages render correctly at narrow viewports.
//
// Output: playwright/screenshots/mobile/<viewport>/<page>.png (gitignored).

const SCREENSHOT_DIR = process.env.RACEIQ_SCREENSHOT_DIR ?? "./screenshots/mobile";

test.beforeAll(async ({ request }) => {
  // Fresh-install server boots with onboardingComplete=false, which makes
  // every page render the wizard. Flip it so the app chrome is reachable.
  const res = await request.put("/api/settings", {
    data: { onboardingComplete: true, driverName: "TestDriver" },
  });
  expect(res.ok()).toBeTruthy();
});

for (const viewport of RESPONSIVE_VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const page of RESPONSIVE_PAGES) {
      test(page.name, async ({ page: p }) => {
        await p.goto(page.path, { waitUntil: "networkidle" });
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
        } else {
          if (viewport.width < 768) {
            await p.getByLabel("Open navigation").click();
          }
          await p.getByRole("button", { name: /Settings|TestDriver/ }).click();
          await expect(
            p.getByRole("heading", { name: "Settings" }),
          ).toBeVisible();
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
