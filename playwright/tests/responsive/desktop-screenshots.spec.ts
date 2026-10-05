import { expect, type Page, test } from "@playwright/test";
import { mockLiveScreenshotTelemetry } from "../support/responsive/live-screenshot";
import { RESPONSIVE_INTERACTION_CASES, RESPONSIVE_PAGES, RESPONSIVE_VIEWPORTS } from "../support/responsive/cases";
import { getSeededLapTarget } from "../support/seeded/laps";
// Responsive screenshot tests.
//
// Runs against seeded webServer with isolated DATA_DIR. Screenshot workflows
// load committed demo fixtures and every route case is eligible.
//
// Desktop-only route and interaction evidence. Device semantics remain in device.spec.ts.
// Output: playwright/screenshots/app/<viewport>/<page>.png (gitignored).

const SCREENSHOT_DIR = process.env.RACEIQ_SCREENSHOT_DIR ?? "./screenshots/app";

async function dismissTransientNotification(page: Page) {
  await page.addStyleTag({
    content: [
      '[role="status"]:has(button),',
      'div.fixed.bottom-4.right-4.z-50 { display: none !important; pointer-events: none !important; }',
    ].join(""),
  });
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: /Settings|TestDriver/ }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
}

for (const viewport of RESPONSIVE_VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const page of RESPONSIVE_PAGES) {
      if (page.viewports && !page.viewports.includes(viewport.name)) continue;

      test(page.name, async ({ page: p, request }) => {
        if (page.liveGameId) await mockLiveScreenshotTelemetry(p, request, page.liveGameId);
        await p.goto(page.path, { waitUntil: "networkidle" });
        await expect(p.locator("[data-responsive-workspace]")).toBeVisible();
        if (page.liveGameId) {
          await expect(p.locator("[data-live-dashboard-layout]")).toBeVisible();
        }
        if (page.readyText) {
          await expect(p.getByText(page.readyText, { exact: false }).first()).toBeVisible();
        }
        if (page.seedReadyText) {
          await expect(p.getByText(page.seedReadyText, { exact: false }).first()).toBeVisible();
        }
        await dismissTransientNotification(p);
        await p.screenshot({
          path: `${SCREENSHOT_DIR}/${viewport.name}/${page.name}.png`,
          fullPage: true,
          animations: "disabled",
        });
      });
    }

    for (const screenshotCase of RESPONSIVE_INTERACTION_CASES) {
      if (screenshotCase.viewports && !screenshotCase.viewports.includes(viewport.name)) continue;

      test(screenshotCase.name, async ({ page: p, request }) => {
        const replayGame = screenshotCase.kind === "analyse-actions" ? "fm-2023" : screenshotCase.kind === "analyse-data-panel-loaded" ? "f1-2025" : null;
        const replayPrefix = screenshotCase.kind === "analyse-actions" ? "fm23" : "f125";
        const target = replayGame ? await getSeededLapTarget(request, replayGame) : null;
        const path = target ? `/${replayPrefix}/sessions/${target.sessionId}/replay/${target.id}` : screenshotCase.path;
        await p.goto(path, { waitUntil: "networkidle" });
        await dismissTransientNotification(p);
        if (screenshotCase.kind === "analyse-data-panel-loaded") await expect(p.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible();
        if (screenshotCase.kind === "settings") {
          await openSettings(p);
          const overlay = p.getByRole("button", { name: "Dismiss settings" });
          await expect(overlay).toHaveCSS("position", "absolute");
          await expect(overlay).toHaveCSS("inset", "0px");
          await expect(overlay).toHaveCSS("width", `${viewport.width}px`);
          await expect(overlay).toHaveCSS("height", `${viewport.height}px`);
          if (viewport.width >= 768) {
            const background = await overlay.evaluate((element) => getComputedStyle(element).backgroundColor);
            await overlay.hover({ position: { x: 4, y: 4 } });
            await expect(overlay).toHaveCSS("background-color", background);
          }
        } else if (screenshotCase.kind === "settings-language") {
          await openSettings(p);
          await p.getByRole("combobox", { name: "Search language...", exact: true }).click();
          await expect(p.getByRole("listbox", { name: "Search language..." })).toBeVisible();
        } else if (screenshotCase.kind === "analyse-actions" || screenshotCase.kind === "analyse-data-panel-loaded") {
          // Keyboard activation also works when a baseline revision overlaps the trigger.
          await p.getByRole("button", { name: "Overlays", exact: true }).focus();
          await p.keyboard.press("Enter");
          await expect(p.getByRole("menu")).toBeVisible();
        } else {
          await p.getByRole("button", { name: "Export / Import" }).click();
          await expect(p.getByRole("menu")).toBeVisible();
        }
        await p.screenshot({
          path: `${SCREENSHOT_DIR}/${viewport.name}/${screenshotCase.name}.png`,
          fullPage: false,
          animations: "disabled",
        });
      });
    }
  });
}
