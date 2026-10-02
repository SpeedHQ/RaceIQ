import { expect, type Page } from "@playwright/test";

export async function assertSynchronizedCursors(page: Page): Promise<void> {
  const charts = page.getByTestId("lap-compare-workspace").locator(".uplot");
  await expect.poll(() => charts.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  const overlays = charts.locator(".u-over");
  const overlay = overlays.nth(1);
  await overlay.scrollIntoViewIfNeeded();
  const box = await overlay.boundingBox();
  expect(box, "comparison chart overlay bounds").not.toBeNull();
  await overlay.hover({ position: { x: box!.width * 0.63, y: box!.height * 0.45 } });

  const chartCount = await charts.count();
  await expect
    .poll(
      async () => {
        const legends = await charts.locator(".u-legend").allTextContents();
        return legends.filter((legend) => /\d/.test(legend)).length;
      },
      { timeout: 10_000 },
    )
    .toBe(chartCount);
  const speedLegend = charts.nth(1).locator(".u-legend");
  await expect(speedLegend).toContainText("Speed A");
  await expect(speedLegend).toContainText("Speed B");
  await expect(speedLegend).toContainText(/\d/);
}
