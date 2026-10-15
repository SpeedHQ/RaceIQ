import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { lapsFor, sessionRows, sessionsFor } from "./helpers";

test("sessions sort laps and compare selected seeded laps", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const sessions = await sessionsFor(request, "fm-2023");
  const laps = await lapsFor(request, "fm-2023");
  const targetSessionIndex = sessions.findIndex((session) => laps.filter((lap) => lap.sessionId === session.id && lap.isValid).length >= 2);
  expect(targetSessionIndex, "seeded session with two valid laps").toBeGreaterThanOrEqual(0);
  expect(targetSessionIndex, "two-lap seeded session must be on first page").toBeLessThan(25);
  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  const first = (await sessionRows(page)).nth(targetSessionIndex);
  await first.click();
  const lapTable = page.locator("[data-slot='table-container'] table").last();
  await expect(lapTable.getByRole("columnheader", { name: "Time" })).toBeVisible();
  await expect(lapTable.getByRole("button", { name: "Replay", exact: true }).first()).toBeVisible();
  await expect(lapTable.getByRole("columnheader", { name: /^S\d+$/ }).first()).toBeVisible();
  await expect(lapTable.getByRole("button", { name: /Add note/ }).first()).toBeVisible();
  const lapSort = lapTable.getByRole("columnheader", { name: /Lap/ }).getByRole("button");
  const previousOrder = await lapTable.locator("tr").filter({ has: page.getByRole("button", { name: "Replay", exact: true }) }).allTextContents();
  await lapSort.focus();
  await page.keyboard.press("Enter");
  await expect(lapSort.locator("..")).toHaveAttribute("aria-sort", /ascending|descending/);
  const nextOrder = await lapTable.locator("tr").filter({ has: page.getByRole("button", { name: "Replay", exact: true }) }).allTextContents();
  expect(nextOrder).not.toEqual(previousOrder);
  const lapRows = page.locator("tbody tbody tr").filter({ has: page.getByRole("button", { name: "Replay", exact: true }) });
  await expect(lapRows.nth(0)).toBeVisible();
  await expect(lapRows.nth(1)).toBeVisible();
  await lapRows.nth(0).getByRole("checkbox").check();
  await lapRows.nth(1).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Compare 2 laps", exact: true }).click();
  await expect(page).toHaveURL(/\/fm23\/compare\?/);
  expect(browserErrors.errors).toEqual([]);
});

test("replaying an available seeded lap opens analysis and AI panel", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const sessions = await sessionsFor(request, "fm-2023");
  const laps = await lapsFor(request, "fm-2023");
  const replayTarget = sessions.slice(0, 25).flatMap((session, sessionIndex) => {
    const visibleLaps = laps
      .filter((lap) => lap.sessionId === session.id)
      .sort((left, right) => right.lapNumber - left.lapNumber)
      .slice(0, 15);
    const lapIndex = visibleLaps.findIndex((lap) => lap.isValid && lap.telemetryAvailable && (lap.rawFrameCount ?? 0) > 0);
    return lapIndex < 0 ? [] : [{ sessionIndex, lapIndex, lap: visibleLaps[lapIndex]! }];
  })[0];
  expect(replayTarget, "visible seeded lap with available telemetry").toBeDefined();
  if (!replayTarget) throw new Error("No visible seeded lap with available telemetry");

  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  await (await sessionRows(page)).nth(replayTarget.sessionIndex).click();
  await page
    .locator("tbody tbody tr")
    .filter({ has: page.getByRole("button", { name: "Replay", exact: true }) })
    .nth(replayTarget.lapIndex)
    .getByRole("button", { name: "Replay", exact: true })
    .click();
  await expect(page).toHaveURL(`/fm23/sessions/${replayTarget.lap.sessionId}/replay/${replayTarget.lap.id}`);
  await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "AI Analysis", exact: true }).click();
  await expect(page.getByText("AI not set up", { exact: true })).toBeVisible();
  expect(browserErrors.errors).toEqual([]);
});

test("expanded lap ledger scrolls internally on mobile", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const sessions = await sessionsFor(request, "fm-2023");
  const laps = await lapsFor(request, "fm-2023");
  const targetSessionIndex = sessions.findIndex((session) => laps.some((lap) => lap.sessionId === session.id && lap.isValid));
  expect(targetSessionIndex, "seeded session with valid lap").toBeGreaterThanOrEqual(0);
  expect(targetSessionIndex, "session must be on first page").toBeLessThan(25);
  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  const card = page.locator('[class*="@3xl/workspace:hidden"] > div').nth(targetSessionIndex);
  await card.click();
  const notesCell = card.locator("[data-slot='table-container'] table").last().locator("tbody tr").last().locator("td").last();
  const childTable = notesCell.locator("xpath=ancestor::div[@data-slot='table-container'][1]");
  await expect(notesCell).toBeAttached();
  await childTable.scrollIntoViewIfNeeded();
  await childTable.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(notesCell).toBeInViewport();
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport);
});
