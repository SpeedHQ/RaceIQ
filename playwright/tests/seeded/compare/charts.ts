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
  await expect(speedLegend).toContainText("A —");
  await expect(speedLegend).toContainText("B —");
  await expect(speedLegend).toContainText(/\d/);
}

export async function assertMapSynchronizedCursors(page: Page): Promise<void> {
  const workspace = page.getByTestId("lap-compare-workspace");
  const map = workspace.getByTestId("compare-overview-track-map");
  const charts = workspace.locator(".uplot");
  await expect.poll(() => charts.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  const box = await map.boundingBox();
  expect(box, "comparison overview map bounds").not.toBeNull();

  const cursors = charts.locator(".u-cursor-x");
  const cursorState = async () => JSON.stringify(await cursors.evaluateAll((elements) => elements.map((element) => (element as HTMLElement).style.transform)));
  const cursorStates: string[] = [];
  for (const xFraction of [0.2, 0.4, 0.6, 0.8]) {
    await map.hover({ position: { x: box!.width * xFraction, y: box!.height * 0.55 } });
    await expect.poll(cursorState, { timeout: 10_000 }).not.toContain('""');
    await expect.poll(cursorState, { timeout: 10_000 }).not.toContain("-10px");
    cursorStates.push(await cursorState());
  }

  expect(new Set(cursorStates).size, "map hover should move synchronized chart cursors").toBeGreaterThan(1);
}
