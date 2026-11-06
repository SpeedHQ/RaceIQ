import { expect, test } from "@playwright/test";
import { compareQuery, getDistinctPair } from "../../../../../playwright/tests/seeded/compare/interaction-helpers";

/**
 * Map markers are SVG <g role="button" tabindex="0"> elements, not
 * HTMLButtons. The replay Space shortcut must exempt every Element (not only
 * HTMLElements) so a focused marker keeps its own Space activation and the
 * replay does not toggle playback instead.
 */
test("Space on a focused map marker seeks and does not toggle playback", async ({ page, request }) => {
  test.setTimeout(140_000);
  const pair = await getDistinctPair(request, "fm-2023");
  await page.goto(`/fm23/compare?${compareQuery(pair)}&view=spectate`);
  await expect(page.locator("[data-spectate-workspace]")).toBeVisible();
  const clock = page.locator("[data-spectate-playback]");
  await expect.poll(async () => Number(await clock.getAttribute("data-duration"))).toBeGreaterThan(0);
  // The spectate session starts paused, so a seek is the only motion to observe.
  await expect(clock).toHaveAttribute("data-playing", "false");

  const marker = page.locator("[data-seek-distance]").nth(1);
  await expect(marker).toBeVisible();
  const seekDistance = await marker.getAttribute("data-seek-distance");
  expect(seekDistance).not.toBeNull();
  await marker.focus();
  await expect.poll(async () => page.evaluate(() => document.activeElement?.getAttribute("data-seek-distance") ?? null)).toBe(seekDistance);

  await page.keyboard.press("Space");
  await expect.poll(async () => Number(await clock.getAttribute("data-a-distance"))).toBeCloseTo(Number(seekDistance), 1);
  await expect(clock).toHaveAttribute("data-playing", "false");
});
