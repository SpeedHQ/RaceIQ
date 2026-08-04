import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { lapsFor, sessionRows, sessionsFor } from "./helpers";

test("sessions analyse and compare navigation uses selected seeded laps", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const sessions = await sessionsFor(request, "fm-2023");
  const laps = await lapsFor(request, "fm-2023");
  const targetSessionIndex = sessions.findIndex((session) => laps.filter((lap) => lap.sessionId === session.id && lap.isValid).length >= 2);
  expect(targetSessionIndex, "seeded session with two valid laps").toBeGreaterThanOrEqual(0);
  expect(targetSessionIndex, "two-lap seeded session must be on first page").toBeLessThan(25);
  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  const first = (await sessionRows(page)).nth(targetSessionIndex);
  await first.click();
  const lapRows = page.locator("tbody tbody tr").filter({ has: page.getByRole("button", { name: "Analyse", exact: true }) });
  await expect(lapRows.nth(0)).toBeVisible();
  await expect(lapRows.nth(1)).toBeVisible();
  await lapRows.nth(0).getByRole("checkbox").check();
  await lapRows.nth(1).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Compare 2 laps", exact: true }).click();
  await expect(page).toHaveURL(/\/fm23\/compare\?/);

  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  const analyseSession = (await sessionRows(page)).first();
  await analyseSession.click();
  await page
    .locator("tbody tbody tr")
    .filter({ has: page.getByRole("button", { name: "Analyse", exact: true }) })
    .first()
    .getByRole("button", { name: "Analyse", exact: true })
    .click();
  await expect(page).toHaveURL(/\/fm23\/analyse\?/);
  expect(browserErrors.errors).toEqual([]);
});
