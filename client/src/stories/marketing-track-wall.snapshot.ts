import { expect, test } from "@playwright/test";
import { openStoryForSnapshot } from "./storybook-ready";
import fixture from "./marketing/track-wall.generated.json" with { type: "json" };

const storyUrl = "/iframe.html?id=marketing-track-wall--browse-background&viewMode=story";

test("marketing track wall renders and scrolls the complete demo catalog", async ({ page }) => {
  const consoleErrors: string[] = [];
  await page.addInitScript(() => {
    new MutationObserver(() => document.querySelectorAll("img").forEach((image) => image.loading = "eager")).observe(document, { childList: true, subtree: true });
  });
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await openStoryForSnapshot(page, storyUrl);
  const wall = page.locator("[data-marketing-track-wall]");
  await expect(wall).toHaveAttribute("data-track-count", String(fixture.tracks.length));
  await expect(wall).toContainText("DEMO DATA");
  await expect(wall.locator("article")).toHaveCount(fixture.tracks.length);
  const scroller = wall.locator('[tabindex="0"]');
  for (const gameId of ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing"]) await expect(wall.locator(`[data-game-id="${gameId}"]`).first()).toBeVisible();
  await expect(wall.locator("article").first()).toContainText(/laps/);
  await expect(wall.locator("article").first()).toContainText(/setup/);
  expect(await scroller.getAttribute("tabindex")).toBe("0");
  const dimensions = await scroller.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(wall.locator("article").last()).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
