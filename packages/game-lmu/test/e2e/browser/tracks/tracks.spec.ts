import { expect, test } from "@playwright/test";
import { collectBrowserErrors } from "raceiq-e2e/test-support/browser-errors";
test("LMU track cards center visible outlines within their map panels", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/lmu/tracks");
  const maps = page.locator('[data-track-map-layers="centerline"]');
  await expect(maps.locator("svg").first()).toBeVisible();
  const offsets = await maps.evaluateAll((hosts) => hosts.map((host) => {
    const svg = host.querySelector<SVGSVGElement>("svg")!;
    const bounds = svg.getBBox();
    const rect = host.getBoundingClientRect();
    const center = new DOMPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2).matrixTransform(svg.getScreenCTM()!);
    return { x: center.x - rect.x - rect.width / 2, y: center.y - rect.y - rect.height / 2 };
  }));
  for (const offset of offsets) {
    expect(Math.abs(offset.x), "outline horizontal center").toBeLessThanOrEqual(1);
    expect(Math.abs(offset.y), "outline vertical center").toBeLessThanOrEqual(1);
  }
  expect(browserErrors.errors, "LMU tracks browser errors").toEqual([]);
});
