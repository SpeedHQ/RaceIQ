import { expect, type Page } from "@playwright/test";

export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        const workspace = document.querySelector<HTMLElement>("[data-responsive-workspace]");
        return root.scrollWidth <= root.clientWidth + 1 && workspace !== null && workspace.scrollWidth <= workspace.clientWidth + 1;
      }),
    )
    .toBe(true);
}

export async function assertInputsInsideViewport(page: Page, testId: string, expectedCount: number) {
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

export const WORKSPACE_VIEWPORTS = [
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
