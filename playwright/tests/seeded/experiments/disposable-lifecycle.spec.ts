import { expect, test } from "@playwright/test";
import { z } from "zod";

import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { getSeededLapTarget } from "../../support/seeded/laps";
import { ExperimentSchema, ImportLapsResponseSchema } from "./schemas";

const VersionSchema = z.object({
  id: z.number(),
  status: z.string(),
  experimentId: z.number(),
});
const SetupFilesSchema = z.object({
  files: z.array(z.object({ absolutePath: z.string().min(1) })),
});

for (const game of SEEDED_GAME_CASES.filter(({ supportedFeatures }) => supportedFeatures.includes("experiments"))) {
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
          baseSetupPath,
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
      if (baseSetupPath === null) {
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

      const comparisonResponse = await request.get(`/api/experiments/${experimentId}/arm-comparison?a=${versionA.id}&b=${versionB.id}&metric=lapTimeSec`);
      expect(comparisonResponse.ok(), `${game.gameId} version comparison`).toBe(true);
      const comparison = z
        .object({
          a: z.object({ n: z.number() }),
          b: z.object({ n: z.number() }),
          significance: z.string(),
        })
        .parse(await comparisonResponse.json());
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
      const versionsWithLaps = z.array(VersionSchema.extend({ lapCount: z.number() })).parse(await versionsResponse.json());
      const importedVersion = game.gameId === "f1-2025" ? versionsWithLaps.find((version) => version.lapCount === 1) : versionsWithLaps.find((version) => version.id === versionA.id);
      expect(importedVersion?.lapCount).toBe(1);

      await page.goto(`/${game.prefix}/experiments/${experimentId}/review?versionId=${importedVersion!.id}`, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(new RegExp(`/experiments/${experimentId}/review\\?versionId=${importedVersion!.id}`));
      await expect(page.getByRole("button", { name: "Session", exact: true })).toBeVisible();

      const deleteResponse = await request.post(`/api/experiments/${experimentId}/versions/${versionB.id}/delete`);
      expect(deleteResponse.ok()).toBe(true);
      const deletedVersions = z.array(VersionSchema).parse(await (await request.get(`/api/experiments/${experimentId}/versions?includeDeleted=1`)).json());
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
          const importableAfterUndo = z.array(z.object({ id: z.number() })).parse(await (await request.get(`/api/experiments/${experimentId}/importable-laps`)).json());
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
