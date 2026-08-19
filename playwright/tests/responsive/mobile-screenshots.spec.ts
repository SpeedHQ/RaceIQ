import { expect, type Page, test } from "@playwright/test";
import { RESPONSIVE_INTERACTION_CASES, RESPONSIVE_PAGES, RESPONSIVE_VIEWPORTS } from "../support/responsive/cases";
import { getSeededLapTarget } from "../support/seeded/laps";
// Responsive screenshot tests.
//
// Runs against seeded webServer with isolated DATA_DIR. Screenshot workflows
// load committed demo fixtures and every route case is eligible.
//
// Inventory covers representative high-risk screens at phone, tablet boundary,
// and desktop widths. Structural route reachability and extra breakpoint edges
// remain in workspaces.spec.ts so screenshot count stays bounded.
//
// Output: playwright/screenshots/mobile/<viewport>/<page>.png (gitignored).

const SCREENSHOT_DIR = process.env.RACEIQ_SCREENSHOT_DIR ?? "./screenshots/mobile";

async function dismissTransientNotification(page: Page) {
  await page.addStyleTag({
    content: [
      '[role="status"]:has(button),',
      'div.fixed.bottom-4.right-4.z-50 { display: none !important; pointer-events: none !important; }',
    ].join(""),
  });
}

async function openSettings(page: Page, viewportWidth: number) {
  if (viewportWidth < 768) {
    await page.getByLabel("Open navigation").click();
  }
  await page.getByRole("button", { name: /Settings|TestDriver/ }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
}

for (const viewport of RESPONSIVE_VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const page of RESPONSIVE_PAGES) {
      if (page.viewports && !page.viewports.includes(viewport.name)) continue;

      test(page.name, async ({ page: p }) => {
        await p.goto(page.path, { waitUntil: "networkidle" });
        await expect(p.locator("[data-responsive-workspace]")).toBeVisible();
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
      if (screenshotCase.mobileOnly && viewport.width >= 768) continue;

      test(screenshotCase.name, async ({ page: p, request }) => {
        const target = screenshotCase.kind === "analyse-data-panel-loaded" ? await getSeededLapTarget(request, "f1-2025") : null;
        const path = target ? `/${"f125"}/analyse?${new URLSearchParams({ track: String(target.trackOrdinal), car: String(target.carOrdinal), lap: String(target.id) })}` : screenshotCase.path;
        await p.goto(path, { waitUntil: "networkidle" });
        await dismissTransientNotification(p);
        if (screenshotCase.kind === "analyse-data-panel-loaded") await expect(p.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible();
        if (screenshotCase.kind === "nav-drawer") {
          await p.getByLabel("Open navigation").click();
          await expect(p.getByRole("navigation").last()).toBeVisible();
        } else if (screenshotCase.kind === "settings") {
          await openSettings(p, viewport.width);
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
          await openSettings(p, viewport.width);
          await p.getByRole("combobox", { name: "Language", exact: true }).click();
          await expect(p.getByRole("listbox", { name: "Search language..." })).toBeVisible();
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
