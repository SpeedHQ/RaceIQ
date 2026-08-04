import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "./seeded-e2e-helpers";
import { SEEDED_GAME_CASES } from "./seeded-e2e-cases";

type TrackCapability = {
  guides: readonly string[];
  setups: readonly string[];
  debug: readonly string[];
};

const TRACK_CAPABILITY: TrackCapability = {
  guides: ["f1-2025", "acc"],
  setups: ["fm-2023", "f1-2025", "acc", "ac-evo"],
  debug: ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing"],
};

const CAR_CAPABILITY = {
  "fm-2023": { catalog: "forza", search: true, compare: true, classFilter: true, drivetrainFilter: true },
  "f1-2025": { catalog: "f1", viewModes: true },
  acc: { catalog: "acc", classFilter: true },
  "ac-evo": { catalog: "ac-evo", classFilter: true },
  iracing: { catalog: "iracing", search: true, categoryFilter: true },
} as const;

for (const game of SEEDED_GAME_CASES) {
  test(`${game.name} tracks support search, sorting, map, and capability routes`, async ({ page, request }) => {
    const browserErrors = collectBrowserErrors(page);
    const curbResponse = await request.get(
      `/api/track-curbs/${game.trackOrdinal}?gameId=${game.gameId}`,
    );
    expect([200, 404], `${game.name} curb capability status`).toContain(curbResponse.status());
    const curbUnavailable = curbResponse.status() === 404;
    await page.goto(`/${game.prefix}/tracks`, { waitUntil: "domcontentloaded" });
    const search = page.getByPlaceholder("Search tracks...");
    await expect(search).toBeVisible({ timeout: 20_000 });
    await search.fill("definitely-no-seeded-track");
    await expect(page.getByText(/No tracks matching/)).toBeVisible();
    await search.fill("");

    const lapsSort = page.getByRole("tab", { name: "Laps", exact: true });
    await lapsSort.click();
    await expect(lapsSort).toHaveAttribute("aria-selected", "true");

    const trackCard = page.getByTestId(`track-card-${game.trackOrdinal}`);
    await expect(trackCard).toBeVisible();
    await trackCard.click();
    await expect(page).toHaveURL(new RegExp(`/${game.prefix}/tracks/${game.trackOrdinal}/?$`));
    await expect(page.getByText(game.trackName, { exact: true }).first()).toBeVisible();

    const infoTab = page.getByRole("tab", { name: "Info", exact: true });
    await expect(infoTab).toHaveAttribute("aria-selected", "true");
    const plus = page.getByRole("button", { name: "+", exact: true });
    if (await plus.count()) {
      await plus.click();
      await expect(page.getByRole("button", { name: "-", exact: true })).toBeVisible();
      await page.getByRole("button", { name: /segments|sectors/i }).click();
    }

    const detailLapsTab = page.getByRole("tab", { name: /^Laps(?: \(\d+\))?$/ });
    await detailLapsTab.click();
    await expect(page).toHaveURL(/\/laps\/?$/);
    await expect(detailLapsTab).toHaveAttribute("aria-selected", "true");
    const lapCheckboxes = page.locator('tbody input[type="checkbox"]');
    if ((await lapCheckboxes.count()) >= 2) {
      await lapCheckboxes.nth(0).check();
      await lapCheckboxes.nth(1).check();
      await expect(page.getByRole("button", { name: "Compare", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Compare", exact: true }).click();
      await expect(page).toHaveURL(/\/compare\?/);
      await page.goBack();
      await expect(page).toHaveURL(/\/laps\/?$/);
    }

    if (TRACK_CAPABILITY.setups.includes(game.gameId)) {
      await page.getByRole("tab", { name: "Setup", exact: true }).click();
      await expect(page).toHaveURL(/\/setups\/?$/);
    }
    if (TRACK_CAPABILITY.guides.includes(game.gameId)) {
      await page.getByRole("tab", { name: /Guide/i }).click();
      await expect(page).toHaveURL(/\/guide\/?$/);
      await expect(page.getByText(/guide|no data|unavailable/i).first()).toBeVisible();
    }
    if (TRACK_CAPABILITY.debug.includes(game.gameId)) {
      await page.getByRole("tab", { name: "Debug", exact: true }).click();
      const edits = page.getByRole("button", { name: "Edit", exact: true });
      const hasSectorEditor = (await edits.count()) > 1;
      if (await edits.count()) {
        await edits.first().click();
        const segmentInputs = page.locator('input[type="number"]');
        if (await segmentInputs.count()) {
          const original = await segmentInputs.first().inputValue();
          await segmentInputs.first().fill(original);
        }
        await expect(page.getByRole("button", { name: "Cancel", exact: true }).first()).toBeVisible();
        await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
      }
      if (hasSectorEditor) {
        const sectorEdit = page.getByRole("button", { name: "Edit", exact: true }).first();
        await sectorEdit.click();
        const sectorInputs = page.locator('input[type="number"]');
        if ((await sectorInputs.count()) >= 2) {
          const original = await sectorInputs.nth(1).inputValue();
          await sectorInputs.nth(1).fill(original);
        }
        await expect(page.getByRole("button", { name: "Cancel", exact: true }).first()).toBeVisible();
        await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
      }
    }
    await page.getByRole("tab", { name: "Info", exact: true }).click();
    await expect(page).not.toHaveURL(/\/(laps|setups|guide|debug)\/?$/);
    const expectedResourceError =
      "console.error: Failed to load resource: the server responded with a status of 404 (Not Found)";
    expect(
      browserErrors.errors.filter(
        (error) =>
          !curbUnavailable ||
          (
            error !== expectedResourceError &&
            !error.includes(`/api/track-curbs/${game.trackOrdinal}?gameId=${game.gameId}`)
          ),
      ),
      `${game.name} tracks browser errors`,
    ).toEqual([]);
  });
}

test("track lap deletion uses imported disposable data and cleans imported session", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const sessionsBeforeResponse = await request.get("/api/sessions?gameId=fm-2023");
  expect(sessionsBeforeResponse.ok()).toBe(true);
  const sessionsBefore = (await sessionsBeforeResponse.json()) as { id: number }[];
  const lapsResponse = await request.get("/api/laps?gameId=fm-2023");
  expect(lapsResponse.ok()).toBe(true);
  const seededLaps = (await lapsResponse.json()) as { id: number; trackOrdinal: number; isValid: boolean }[];
  const source = seededLaps.find((lap) => lap.isValid);
  if (!source) throw new Error("Missing valid FM lap for disposable import");
  const exportResponse = await request.get(`/api/laps/${source.id}/export-bin`);
  expect(exportResponse.ok()).toBe(true);
  const importResponse = await request.post("/api/laps/import", {
    multipart: {
      file: {
        name: "tracks-cars-disposable.bin.gz",
        mimeType: "application/octet-stream",
        buffer: await exportResponse.body(),
      },
    },
  });
  expect(importResponse.ok()).toBe(true);
  let importedLapIds: number[] = [];
  let importedSessionIds: number[] = [];
  try {
    const imported = (await importResponse.json()) as { laps?: { lapId: number }[] };
    importedLapIds = imported.laps?.map((lap) => lap.lapId) ?? [];
    expect(importedLapIds.length).toBeGreaterThan(0);
    const sessionsAfterResponse = await request.get("/api/sessions?gameId=fm-2023");
    expect(sessionsAfterResponse.ok()).toBe(true);
    const sessionIdsBefore = new Set(sessionsBefore.map((session) => session.id));
    importedSessionIds = ((await sessionsAfterResponse.json()) as { id: number }[])
      .filter((session) => !sessionIdsBefore.has(session.id))
      .map((session) => session.id);
    await page.goto(`/fm23/tracks/${source.trackOrdinal}/laps`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("tab", { name: /^Laps(?: \(\d+\))?$/ })).toHaveAttribute("aria-selected", "true");
    const importedRow = page.locator(`[data-testid="track-lap-${importedLapIds[0]}"]`);
    await expect(importedRow).toBeVisible({ timeout: 20_000 });
    await importedRow.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /Delete \(1\)/ }).click();
    await page.getByRole("button", { name: "Yes", exact: true }).click();
    await expect(importedRow).toHaveCount(0);
    expect(browserErrors.errors, "track deletion browser errors").toEqual([]);
  } finally {
    if (importedLapIds.length > 0) {
      const cleanup = await request.post("/api/laps/bulk-delete", { data: { ids: importedLapIds } });
      expect(cleanup.ok(), "cleanup imported laps").toBe(true);
    }
    if (importedSessionIds.length > 0) {
      const cleanup = await request.post("/api/sessions/bulk-delete", { data: { ids: importedSessionIds } });
      expect(cleanup.ok(), "cleanup imported sessions").toBe(true);
    }
  }
});

for (const game of SEEDED_GAME_CASES) {
  test(`${game.name} cars expose explicit catalog interactions`, async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    const capability = CAR_CAPABILITY[game.gameId];
    await page.goto(`/${game.prefix}/cars`, { waitUntil: "domcontentloaded" });

    if (capability.catalog === "forza") {
      const search = page.getByPlaceholder("Search name, division, engine...");
      await expect(search).toBeVisible({ timeout: 20_000 });
      await search.fill("definitely-no-seeded-car");
      await expect(page.getByText("No cars match filters", { exact: true })).toBeVisible();
      await search.fill("");
      await page.getByRole("button", { name: "RWD", exact: true }).click();
      await expect(page.getByRole("button", { name: "RWD", exact: true })).toHaveClass(/bg-app-accent\/20/);
      const cards = page.locator('[role="button"]').filter({ has: page.locator('input[type="checkbox"]') });
      await expect(cards.first()).toBeVisible();
      await cards.first().focus();
      await cards.first().press("Enter");
      const detail = page.getByRole("dialog");
      await expect(detail).toBeVisible();
      const model3d = detail.getByTitle("View 3D model");
      if (await model3d.count()) {
        await expect(model3d).toBeVisible();
        await expect(page).toHaveURL(/\/cars$/);
      }
      await detail.getByRole("button", { name: "Close" }).click();
      await cards.nth(0).locator('input[type="checkbox"]').check();
      await cards.nth(1).locator('input[type="checkbox"]').check();
      await page.getByRole("button", { name: "Compare (2)" }).click();
      await expect(page.getByRole("heading", { name: "Compare Cars" })).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
      await page.getByRole("button", { name: "Clear" }).click();
      await page.getByTitle("Table view").click();
      const piHeader = page.getByRole("columnheader", { name: "PI" });
      await piHeader.click();
      await expect(piHeader).toHaveAttribute("aria-sort", /ascending|descending/);
      await expect(page.locator("tbody tr").first()).toBeVisible();
      await page.getByTitle("Grid view").click();
    } else if (capability.catalog === "f1") {
      await expect(page.getByRole("heading", { name: "Power Unit Suppliers" })).toBeVisible();
      await page.getByTitle("Table view").click();
      await expect(page.locator("tbody tr").first()).toBeVisible();
      await page.getByTitle("Grid view").click();
      await expect(page.getByRole("img", { name: "Red Bull Racing RB21" })).toBeVisible();
    } else if (capability.catalog === "iracing") {
      const search = page.getByPlaceholder("Search name, division, engine...");
      await expect(search).toBeVisible({ timeout: 20_000 });
      await search.fill("definitely-no-seeded-car");
      await expect(page.getByText("No cars match filters", { exact: true })).toBeVisible();
      await search.fill("");
      const category = page.locator("button[data-catalog-category]").first();
      await expect(category).toBeVisible();
      await category.click();
      await expect(category).toHaveAttribute("aria-pressed", "true");
    } else {
      const category = page.locator("button[data-catalog-category]").first();
      await expect(category).toBeVisible({ timeout: 20_000 });
      await category.click();
      await expect(category).toHaveAttribute("aria-pressed", "true");
    }
    expect(browserErrors.errors, `${game.name} cars browser errors`).toEqual([]);
  });
}
