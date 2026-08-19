import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { cleanDisposable, importDisposableLap, sessionsFor, type DisposableImport } from "./helpers";

test("successful session deletion removes only disposable API-created record", async ({ page, request }) => {
  const seededBefore = await sessionsFor(request, "fm-2023");
  let disposable: DisposableImport | undefined;
  try {
    disposable = await importDisposableLap(request, "fm-2023", "sessions-delete");
    const browserErrors = collectBrowserErrors(page);
    await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("Search track, car, notes…").fill(disposable.note);
    const row = page
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name: "Recap", exact: true }) })
      .first();
    await expect(row).toBeVisible();
    await row.getByRole("checkbox").check();
    const deleted = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/sessions/bulk-delete");
    await page.getByRole("button", { name: /^Delete / }).click();
    await page.getByRole("button", { name: "Yes", exact: true }).click();
    expect((await deleted).ok()).toBe(true);
    await expect(row).toHaveCount(0);
    const after = await sessionsFor(request, "fm-2023");
    expect(new Set(after.map((session) => session.id))).toEqual(new Set(seededBefore.map((session) => session.id)));
    disposable = undefined;
    expect(browserErrors.errors).toEqual([]);
  } finally {
    if (disposable) await cleanDisposable(request, disposable);
  }
});
