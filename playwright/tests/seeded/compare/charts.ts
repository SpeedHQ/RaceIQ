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

  await expect.poll(async () => {
    const distances = await charts.evaluateAll((plots) => plots.map((plot) => plot.querySelector(".u-legend .u-value")?.textContent));
    return distances.length >= 4 && distances.every((distance) => distance != null && /\d/.test(distance) && distance === distances[0]);
  }).toBe(true);
}
