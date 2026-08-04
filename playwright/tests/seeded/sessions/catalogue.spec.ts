import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { sessionsFor, sessionRows } from "./helpers";

test("sessions filter, notes, recap, export, and deletion confirmation preserve seeded data", async ({ page, request }) => {
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
  await firstRow.getByRole("button", { name: "Recap", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Best lap", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const downloadPromise = page.waitForEvent("download");
  await firstRow.getByRole("button", { name: "Export", exact: true }).click();
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
  await page.goto("/ac-evo/sessions?tab=imported", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Imported", exact: true })).toHaveAttribute("class", /bg-app-accent/);
  const search = page.getByPlaceholder("Search track, car, notes…");
  await search.fill("definitely-no-imported-session");
  await expect(page.getByText("No imported logs yet", { exact: true }).last()).toBeVisible();
  await search.fill("");
  await page.getByRole("button", { name: "Recorded", exact: true }).click();
  await expect(page).toHaveURL(/\/ac-evo\/sessions(?:\?.*)?$/);
  await expect(page.getByRole("button", { name: "Recorded", exact: true })).toHaveAttribute("class", /bg-app-accent/);
  expect(browserErrors.errors).toEqual([]);
});

test("sessions pagination advances when seeded data exceeds one page", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  const rows = await sessionRows(page);
  const seededCount = await rows.count();
  const next = page.getByRole("button", { name: "Next", exact: true });
  if ((await next.count()) === 0) {
    expect(browserErrors.errors).toEqual([]);
    return;
  }
  await expect(next).toBeEnabled();
  const showingBefore = await page
    .getByText(/Showing\s+1–/)
    .first()
    .innerText();
  await next.click();
  await expect(page.getByText(new RegExp(`Showing\\s+${Math.min(26, seededCount + 1)}–`)).first()).toBeVisible();
  expect(await page.getByRole("button", { name: "Previous", exact: true }).isEnabled()).toBe(true);
  expect(showingBefore).not.toEqual(
    await page
      .getByText(/Showing\s+1–/)
      .first()
      .innerText()
      .catch(() => ""),
  );
  expect(browserErrors.errors).toEqual([]);
});
