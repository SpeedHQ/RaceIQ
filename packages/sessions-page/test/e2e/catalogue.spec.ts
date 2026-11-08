import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../../../playwright/tests/support/browser-errors"
import { cleanDisposable, importDisposableLap, sessionsFor, sessionRows, type DisposableImport } from "../../../../playwright/tests/support/session-fixtures";

test("sessions filter, analysis, notes, export, and deletion confirmation preserve seeded data", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const seededBefore = await sessionsFor(request, "fm-2023");
  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();

  const search = page.getByPlaceholder("Search track, car, notes…");
  await search.fill("definitely-no-seeded-session");
  await expect(page.getByText("No sessions recorded yet", { exact: true }).last()).toBeVisible();
  await search.fill("");

  const firstRow = (await sessionRows(page)).first();
  await expect(firstRow).toBeVisible();
  await firstRow.getByRole("button", { name: "Analyse Session", exact: true }).click();
  await expect(page).toHaveURL(/\/fm23\/sessions\/\d+\/analyse(?:\?.*)?$/);
  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  const returnedFirstRow = (await sessionRows(page)).first();
  await returnedFirstRow.click();
  const exportReplay = page.getByRole("button", { name: "Replay", exact: true }).first();
  await exportReplay.locator("xpath=ancestor::tr[1]").getByRole("checkbox").check();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/\.zip$/);

  const noteButton = firstRow.locator("td").last().getByRole("button");
  const replacementNote = `seeded-e2e-note-${Date.now()}`;
  await noteButton.click();
  const noteDialog = page.getByRole("dialog");
  const originalNote = await noteDialog.getByRole("textbox").inputValue();
  let noteRestored = false;
  try {
    await noteDialog.getByRole("textbox").fill(replacementNote);
    const saveResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && /\/api\/sessions\/\d+\/notes$/.test(new URL(response.url()).pathname));
    await noteDialog.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saveResponse).ok()).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await search.fill(replacementNote);
    await expect(page.getByText(replacementNote, { exact: true }).last()).toBeVisible();

    await search.fill("");
    const selection = (await sessionRows(page)).first().getByRole("checkbox");
    await selection.check();
    await page.getByRole("button", { name: /^Delete / }).click();
    await expect(page.getByText("Confirm?", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Delete / })).toBeVisible();
    await selection.uncheck();

    const restored = await request.patch(`/api/sessions/${seededBefore[0]?.id}/notes`, { data: { notes: originalNote || null } });
    expect(restored.ok(), "restore seeded note").toBe(true);
    noteRestored = true;
    const seededAfter = await sessionsFor(request, "fm-2023");
    expect(new Set(seededAfter.map((session) => session.id))).toEqual(new Set(seededBefore.map((session) => session.id)));
    expect(seededAfter.find((session) => session.id === seededBefore[0]?.id)?.notes ?? null).toBe(originalNote || null);
    expect(browserErrors.errors).toEqual([]);
  } finally {
    if (!noteRestored) {
      const restored = await request.patch(`/api/sessions/${seededBefore[0]?.id}/notes`, { data: { notes: originalNote || null } });
      expect(restored.ok(), "restore seeded note after failure").toBe(true);
    }
  }
});

test("sessions recorded and imported tabs expose true-empty state", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/ac-evo/sessions?tab=others", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Others", exact: true })).toHaveAttribute("aria-pressed", "true");
  const search = page.getByPlaceholder("Search track, car, notes…");
  await search.fill("definitely-no-imported-session");
  await expect(page.getByText("No sessions from other drivers yet", { exact: true }).last()).toBeVisible();
  await search.fill("");
  await page.getByRole("button", { name: "Mine", exact: true }).click();
  await expect(page).toHaveURL(/\/ac-evo\/sessions(?:\?.*)?$/);
  await expect(page.getByRole("button", { name: "Mine", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(browserErrors.errors).toEqual([]);
});

test("sessions pagination advances and filtering resets to the first page", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const label = `pagination-${crypto.randomUUID()}`;
  const disposable: DisposableImport[] = [];
  try {
    for (let index = 0; index < 26; index++) disposable.push(await importDisposableLap(request, "fm-2023", label));
    await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
    const search = page.getByPlaceholder("Search track, car, notes…");
    await search.fill(label);
    await expect(page.getByText("Showing 1–25 of 26", { exact: true })).toBeVisible();
    await expect(sessionRows(page)).toHaveCount(25);
    const next = page.getByRole("button", { name: "Next", exact: true });
    await next.focus();
    await next.press("Enter");
    await expect(page.getByText("Showing 26–26 of 26", { exact: true })).toBeVisible();
    await expect(sessionRows(page)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Prev", exact: true })).toBeEnabled();
    await search.fill(`${label}-no-match`);
    await expect(page.getByText("No sessions recorded yet", { exact: true }).last()).toBeVisible();
    await search.fill(label);
    await expect(page.getByText("Showing 1–25 of 26", { exact: true })).toBeVisible();
    expect(browserErrors.errors).toEqual([]);
  } finally {
    for (const imported of disposable) await cleanDisposable(request, imported);
  }
});
