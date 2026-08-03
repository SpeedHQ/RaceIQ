import { expect, test } from "@playwright/test";
import { z } from "zod";

import { SEEDED_GAME_CASES } from "./seeded-e2e-cases";
import {
  collectBrowserErrors,
  getSeededLapTarget,
} from "./seeded-e2e-helpers";

const DriverProfileSchema = z.object({
  gameName: z.string(),
  fingerprint: z.object({
    trend: z.object({
      recent: z.object({ total: z.number() }),
    }),
  }),
});

const DriverRunsSchema = z.object({
  configured: z.boolean(),
  state: z.string(),
  runs: z.array(z.object({ id: z.number(), status: z.string(), createdAt: z.string() })),
});

const DriverRunMutationSchema = z.object({
  state: z.string(),
  run: z.unknown().nullable(),
});

const ExperimentSchema = z.object({ id: z.number() });
const ImportLapsResponseSchema = z.object({ importedIds: z.array(z.number()) });
const VersionSchema = z.object({
  id: z.number(),
  status: z.string(),
  experimentId: z.number(),
});
const SetupFilesSchema = z.object({
  files: z.array(z.object({ absolutePath: z.string().min(1) })),
});

for (const game of SEEDED_GAME_CASES.filter(({ supportedFeatures }) =>
  supportedFeatures.includes("driver")
)) {
  test(`${game.name} Driver profile matches deterministic API state`, async ({
    page,
    request,
  }) => {
    const browserErrors = collectBrowserErrors(page);
    const headers = { "X-Game-Id": game.gameId };
    const profileResponse = await request.get("/api/drivers/profile", { headers });
    expect(profileResponse.ok()).toBe(true);
    const profile = DriverProfileSchema.parse(await profileResponse.json());
    const runsResponse = await request.get("/api/drivers/profile/runs", { headers });
    expect(runsResponse.ok()).toBe(true);
    const runs = DriverRunsSchema.parse(await runsResponse.json());
    const invalidRunResponse = await request.post("/api/drivers/profile/runs", { headers });
    expect(invalidRunResponse.status()).toBe(400);
    if (!runs.configured) {
      expect(runs.state).toBe("not-configured");
      for (const action of ["runNow=true", "retry=true"]) {
        const runResponse = await request.post(`/api/drivers/profile/runs?${action}`, { headers });
        expect(runResponse.ok()).toBe(true);
        expect(DriverRunMutationSchema.parse(await runResponse.json())).toMatchObject({
          state: "not-configured",
          run: null,
        });
      }
    }

    await page.goto(`/${game.prefix}/driver`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Driver Profile" })).toBeVisible();
    await expect(page.getByText(`All ${profile.gameName} laps`, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
    if (runs.runs.length === 0) {
      await expect(page.getByText("No AI runs yet.", { exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: `All ${profile.gameName} laps`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${game.prefix}/sessions(?:\\?.*)?$`));
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Driver Profile" })).toBeVisible();
    await expect(page.getByText(`latest ${profile.fingerprint.trend.recent.total}`, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Full profile detail" })).toBeVisible();
    await expect(page.getByText("Recurring patterns", { exact: true })).toBeVisible();
    await expect(page.getByText("Data caveats", { exact: true })).toBeVisible();
    if (!runs.configured) {
      expect(runs.state).toBe("not-configured");
      await expect(
        page.getByRole("heading", { name: "Provider not configured" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Refresh AI summary" })).toBeDisabled();
    }


    expect(browserErrors.errors, `unexpected ${game.gameId} Driver browser errors`).toEqual([]);
  });
}
test("Driver profile presents deterministic API error state", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.route("**/api/drivers/profile", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "seeded profile failure" }) }),
  );
  try {
    await page.goto("/f125/driver", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText("Measured profile unavailable.", { exact: true })).toBeVisible();
  } finally {
    await page.unroute("**/api/drivers/profile");
  }
  expect(browserErrors.errors, "unexpected browser errors in Driver error state").toEqual([]);
});

test("F1 experiment creates, switches focus, imports laps, uses history, and archives", async ({
  page,
  request,
}) => {
  page.setDefaultTimeout(10_000);
  test.setTimeout(180_000);
  const browserErrors = collectBrowserErrors(page);
  const seededLap = await getSeededLapTarget(request, "f1-2025");
  const trackResponse = await request.get(
    `/api/track-name/${seededLap.trackOrdinal}?gameId=f1-2025`,
  );
  const carResponse = await request.get(
    `/api/car-name/${seededLap.carOrdinal}?gameId=f1-2025`,
  );
  expect(trackResponse.ok()).toBe(true);
  expect(carResponse.ok()).toBe(true);
  const trackName = await trackResponse.text();
  const carName = await carResponse.text();
  let pendingUndoCount = 0;
  const experimentName = `Seeded F1 experiment ${Date.now()}`;
  let experimentId: number | null = null;

  try {
    await page.goto("/f125/experiments", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Experiments" })).toBeVisible();
    await page.getByRole("button", { name: "+ New experiment" }).click();
    const createDialog = page.getByRole("dialog");
    await expect(createDialog.getByRole("heading", { name: "New experiment" })).toBeVisible();
    await createDialog.getByRole("button", { name: /^Driver / }).click();
    await createDialog.getByPlaceholder("Car name").fill(carName);
    await createDialog.getByRole("combobox", { name: "Search tracks…" }).click();
    await page.getByRole("option", { name: trackName, exact: true }).click();
    await createDialog.getByPlaceholder(new RegExp(`${carName} @ `)).fill(experimentName);
    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/experiments",
    );
    await createDialog.getByRole("button", { name: "Create session" }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.ok()).toBe(true);
    experimentId = ExperimentSchema.parse(await createResponse.json()).id;

    await expect(page).toHaveURL(new RegExp(`/f125/experiments/${experimentId}$`));
    await expect(page.getByRole("heading", { name: new RegExp(experimentName) })).toBeVisible();
    await expect(page.getByRole("button", { name: "Driver", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.getByRole("button", { name: "Car", exact: true }).click();
    await page.getByPlaceholder("Why the switch? (optional)").fill("Seeded focus transition");
    const focusResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        /\/api\/experiments\/\d+\/focus$/.test(new URL(response.url()).pathname),
    );
    await page.getByRole("button", { name: "Switch", exact: true }).click();
    expect((await focusResponse).ok()).toBe(true);
    await expect(page.getByRole("button", { name: "Car", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.getByRole("button", { name: "Add laps from history" }).click();
    const importDialog = page.getByRole("dialog");
    await expect(importDialog.getByText(/Importable laps \([1-9]\d*\)/)).toBeVisible();
    await importDialog.getByRole("button", { name: "Select all" }).click();
    const importResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/experiments\/\d+\/import-laps$/.test(new URL(response.url()).pathname),
    );
    await importDialog.getByRole("button", { name: /Import \d+ laps?/ }).click();
    const importApiResponse = await importResponse;
    expect(importApiResponse.ok()).toBe(true);
    const imported = ImportLapsResponseSchema.parse(await importApiResponse.json());
    expect(imported.importedIds.length).toBeGreaterThan(0);
    pendingUndoCount += 1;
    await expect(page.getByText("Laps", { exact: true }).locator("..")).toContainText(
      `Laps${imported.importedIds.length}`,
    );

    await page.getByRole("button", { name: "History", exact: true }).click();
    const historyDialog = page.getByRole("dialog");
    await expect(historyDialog.getByText("Imported laps", { exact: true })).toBeVisible();
    const undoImport = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/experiments\/\d+\/undo$/.test(new URL(response.url()).pathname),
    );
    await historyDialog.getByRole("button", { name: "Undo last" }).click();
    expect((await undoImport).ok()).toBe(true);
    pendingUndoCount -= 1;
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "History", exact: true }).click();
    const focusHistory = page.getByRole("dialog");
    await expect(
      focusHistory.getByText("Nothing left to undo.", { exact: true }),
    ).toBeVisible();
    await expect(focusHistory.getByText("Driver", { exact: true })).toBeVisible();
    await expect(focusHistory.getByText("Car", { exact: true })).toBeVisible();
    await expect(focusHistory.getByText(/Seeded focus transition/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Car", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.getByRole("button", { name: "Dashboard", exact: true }).click();
    await expect(page.getByText("Current stint", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("button", { name: "Dashboard", exact: true })).toBeVisible();
  } finally {
    while (pendingUndoCount > 0 && experimentId != null) {
      const undo = await request.post(`/api/experiments/${experimentId}/undo`);
      expect(undo.ok(), `undo pending action for experiment ${experimentId}`).toBe(true);
      pendingUndoCount -= 1;
    }
    if (experimentId != null) {
      const archive = await request.patch(`/api/experiments/${experimentId}`, {
        data: { status: "archived" },
      });
      expect(archive.ok(), `archive experiment ${experimentId}`).toBe(true);
    }
  }

  expect(browserErrors.errors, "unexpected browser errors in experiment flow").toEqual([]);
});

for (const game of SEEDED_GAME_CASES.filter(({ supportedFeatures }) =>
  supportedFeatures.includes("experiments"),
)) {
  test(`${game.name} experiment lifecycle persists and recovers disposable state`, async ({ page, request }) => {
    page.setDefaultTimeout(10_000);
    const browserErrors = collectBrowserErrors(page);
    const seededLap = await getSeededLapTarget(request, game.gameId);
    const [trackResponse, carResponse] = await Promise.all([
      request.get(`/api/track-name/${seededLap.trackOrdinal}?gameId=${game.gameId}`),
      request.get(`/api/car-name/${seededLap.carOrdinal}?gameId=${game.gameId}`),
    ]);
    let importedLapId: number | null = null;
    expect(trackResponse.ok()).toBe(true);
    expect(carResponse.ok()).toBe(true);
    const trackName = await trackResponse.text();
    const carName = await carResponse.text();
    let experimentId: number | null = null;

    try {
      let baseSetupPath: string | null = null;
      if (game.gameId !== "f1-2025") {
        const setupFilesResponse = await request.get(`/api/tunes/setup-files?gameId=${game.gameId}`);
        expect(setupFilesResponse.ok(), `${game.gameId} setup catalog`).toBe(true);
        const setupFiles = SetupFilesSchema.parse(await setupFilesResponse.json()).files;
        test.skip(setupFiles.length === 0, `${game.gameId} setup evidence unavailable`);
        baseSetupPath = setupFiles[0]?.absolutePath ?? null;
      }

      const experimentName = `E2E ${game.gameId} lifecycle ${Date.now()}`;
      const createResponse = await request.post("/api/experiments", {
        data: {
          gameId: game.gameId,
          name: experimentName,
          carOrdinal: seededLap.carOrdinal,
          trackOrdinal: seededLap.trackOrdinal,
          carName,
          trackName,
          focus: "car",
        },
      });
      expect(createResponse.status()).toBe(201);
      experimentId = ExperimentSchema.parse(await createResponse.json()).id;

      await page.goto(`/${game.prefix}/experiments`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Experiments" })).toBeVisible();
      await expect(page.getByText(experimentName, { exact: true })).toBeVisible();
      await page.getByText(experimentName, { exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/${game.prefix}/experiments/${experimentId}$`));
      await expect(page.getByRole("heading", { name: new RegExp(experimentName) })).toBeVisible();
      await expect(page.getByText("Race engineer", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Add laps from history" })).toBeVisible();

      let versionsResponse = await request.get(`/api/experiments/${experimentId}/versions`);
      expect(versionsResponse.ok()).toBe(true);
      let versions = z.array(VersionSchema).parse(await versionsResponse.json());
      if (game.gameId === "f1-2025") {
        expect(versions).toHaveLength(0);
        for (const label of ["v1", "v2"]) {
          const versionResponse = await request.post(`/api/experiments/${experimentId}/versions`, {
            data: { label, parentVersionId: null, setupPath: null, engine: null },
          });
          expect(versionResponse.status()).toBe(201);
        }
        versionsResponse = await request.get(`/api/experiments/${experimentId}/versions`);
        versions = z.array(VersionSchema).parse(await versionsResponse.json());
      } else {
        expect(versions.length).toBeGreaterThan(0);
        const addBaseResponse = await request.post(`/api/experiments/${experimentId}/bases`, {
          data: { setupPath: baseSetupPath, label: "E2E second base", setHead: true },
        });
        expect(addBaseResponse.status()).toBe(201);
        versionsResponse = await request.get(`/api/experiments/${experimentId}/versions`);
        versions = z.array(VersionSchema).parse(await versionsResponse.json());
      }
      expect(versions.length).toBeGreaterThanOrEqual(2);
      const versionA = versions[0]!;
      const versionB = versions[1]!;

      const comparisonResponse = await request.get(
        `/api/experiments/${experimentId}/arm-comparison?a=${versionA.id}&b=${versionB.id}&metric=lapTimeSec`,
      );
      expect(comparisonResponse.ok(), `${game.gameId} version comparison`).toBe(true);
      const comparison = z.object({
        a: z.object({ n: z.number() }),
        b: z.object({ n: z.number() }),
        significance: z.string(),
      }).parse(await comparisonResponse.json());
      expect(comparison.a.n).toBeGreaterThanOrEqual(0);
      expect(comparison.b.n).toBeGreaterThanOrEqual(0);

      const focusResponse = await request.patch(`/api/experiments/${experimentId}/focus`, {
        data: { focus: "driver", note: `E2E ${game.gameId} focus` },
      });
      expect(focusResponse.ok()).toBe(true);
      const focusHistoryResponse = await request.get(`/api/experiments/${experimentId}/focus-history`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByText("Driver coach", { exact: true })).toBeVisible();
      expect(focusHistoryResponse.ok()).toBe(true);
      expect(JSON.stringify(await focusHistoryResponse.json())).toContain(`E2E ${game.gameId} focus`);

      const importableResponse = await request.get(`/api/experiments/${experimentId}/importable-laps`);
      expect(importableResponse.ok()).toBe(true);
      const importable = z.array(z.object({ id: z.number() })).parse(await importableResponse.json());
      test.skip(importable.length === 0, `${game.gameId} unattached lap evidence unavailable`);
      const lapId = importable[0]!.id;

      await page.getByRole("button", { name: "Add laps from history" }).click();
      const importDialog = page.getByRole("dialog");
      await expect(importDialog).toBeVisible();
      await importDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(importDialog).toHaveCount(0);

      const importResponse = await request.post(`/api/experiments/${experimentId}/import-laps`, {
        data: { lapIds: [lapId], experimentVersionId: versionA.id },
      });
      expect(importResponse.status()).toBe(201);
      importedLapId = lapId;
      expect(ImportLapsResponseSchema.parse(await importResponse.json()).importedIds).toEqual([lapId]);
      versionsResponse = await request.get(`/api/experiments/${experimentId}/versions`);
      versions = z.array(VersionSchema.extend({ lapCount: z.number() })).parse(await versionsResponse.json());
      expect(versions.find((version) => version.id === versionA.id)?.lapCount).toBe(1);

      await page.goto(`/${game.prefix}/experiments/${experimentId}/review?versionId=${versionA.id}`, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(new RegExp(`/experiments/${experimentId}/review\\?versionId=${versionA.id}`));
      await expect(page.getByRole("button", { name: "Session", exact: true })).toBeVisible();

      const deleteResponse = await request.post(`/api/experiments/${experimentId}/versions/${versionB.id}/delete`);
      expect(deleteResponse.ok()).toBe(true);
      const deletedVersions = z.array(VersionSchema).parse(
        await (await request.get(`/api/experiments/${experimentId}/versions?includeDeleted=1`)).json(),
      );
      expect(deletedVersions.find((version) => version.id === versionB.id)?.status).toBe("deleted");
      const undoDeleteResponse = await request.post(`/api/experiments/${experimentId}/undo`);
      expect(undoDeleteResponse.ok()).toBe(true);
      const recoveredVersions = z.array(VersionSchema).parse(await (await request.get(`/api/experiments/${experimentId}/versions`)).json());
      expect(recoveredVersions.find((version) => version.id === versionB.id)?.status).toBe("active");
      const historyResponse = await request.get(`/api/experiments/${experimentId}/actions`);
      expect(historyResponse.ok()).toBe(true);
      expect(JSON.stringify(await historyResponse.json())).toContain('"undone":true');

      const chatResponse = await request.get(`/api/experiments/${experimentId}/chat`);
      expect(chatResponse.ok(), `${game.gameId} setup chat history`).toBe(true);
    } finally {
      if (experimentId != null) {
        if (importedLapId != null) {
          const restoredLapId = importedLapId;
          const undoImportResponse = await request.post(`/api/experiments/${experimentId}/undo`);
          expect(undoImportResponse.ok(), `undo imported lap ${restoredLapId}`).toBe(true);
          const importableAfterUndo = z.array(z.object({ id: z.number() })).parse(
            await (await request.get(`/api/experiments/${experimentId}/importable-laps`)).json(),
          );
          expect(importableAfterUndo.some((lap) => lap.id === restoredLapId)).toBe(true);
          importedLapId = null;
        }
        const archiveResponse = await request.patch(`/api/experiments/${experimentId}`, {
          data: { status: "archived" },
        });
        expect(archiveResponse.ok(), `archive disposable ${game.gameId} experiment`).toBe(true);
      }
    }
    expect(browserErrors.errors, `unexpected ${game.gameId} experiment browser errors`).toEqual([]);
  });
}
