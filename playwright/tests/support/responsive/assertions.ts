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
