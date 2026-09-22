import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { sessionRows } from "./helpers";

test("selected-session cleanup previews protection and waits for confirmation", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  let executeCalls = 0;
  await page.route("**/api/storage/session-cleanup/preview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidateSessionIds: [1],
        protectedSessionIds: [2],
        unavailableSessionIds: [],
        fileCount: 1,
        reclaimableBytes: 4096,
      }),
    });
  });
  await page.route("**/api/storage/session-cleanup", async (route) => {
    executeCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidateSessionIds: [1],
        protectedSessionIds: [2],
        unavailableSessionIds: [],
        fileCount: 1,
        reclaimableBytes: 4096,
        cleanedSessionIds: [1],
        deletedFiles: 1,
        freedBytes: 4096,
        failed: [],
      }),
    });
  });

  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  const first = sessionRows(page).first();
  await first.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Free space", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Protected sessions")).toBeVisible();
  expect(executeCalls).toBe(0);
  await page.getByRole("button", { name: "Remove raw telemetry", exact: true }).click();
  await expect.poll(() => executeCalls).toBe(1);
  expect(browserErrors.errors).toEqual([]);
});
