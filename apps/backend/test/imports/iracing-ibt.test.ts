import {
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { getDiscoveredCarName } from "@raceiq/backend-core/db/discovered-cars";
import { getDiscoveredTrackName } from "@raceiq/backend-core/db/discovered-tracks";
import { db } from "@raceiq/backend-core/db/index";
import { discoveredCars, discoveredTracks } from "@raceiq/backend-core/db/schema";
import { getLapsRaw } from "@raceiq/backend-core/db/lap-read-queries";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import { commitStagedIbt, stageIbtUpload } from "../../src/imports/iracing-ibt";
import { previewIbtFile } from "@raceiq/game-iracing/ibt-preview";
import { initServerGameAdapters } from "../../src/games/init";
import { iracingAdapter } from "@raceiq/shared/games/iracing/index";
import { initGameAdapters } from "@raceiq/shared/games/init";
import {
  createRecording,
  drivenRows,
} from "@raceiq/game-iracing/test-support/games/iracing-ibt";
import type { SyntheticIdentity } from "@raceiq/game-iracing/test-support/games/iracing-ibt";

initGameAdapters();
initServerGameAdapters();

describe("IRacingIbt import workflow", () => {
  test("previews a driven recording without writing it to the database", async () => {
    const recording = createRecording("driven.ibt", drivenRows());
    try {
      const preview = await previewIbtFile(recording.path);
      expect(preview).toMatchObject({
        gameId: "iracing",
        trackName: "Road America",
        carName: "GT3 Test Car",
        drivingFrames: 6,
        lapTransitions: 2,
        candidateLapCount: 1,
        canImport: true,
        reason: null,
      });
      expect(preview.maxSpeedMph).toBeGreaterThan(100);
    } finally {
      recording.cleanup();
    }
  });

  test("commits a staged IBT through the normal pipeline and canonical recorder", async () => {
    const importedIdentity: SyntheticIdentity = {
      trackId: 910_099,
      trackName: "Imported Raceway",
      carId: 910_042,
      carName: "Imported GT3",
    };
    const recording = createRecording(
      "driven.ibt",
      drivenRows(),
      importedIdentity,
    );
    try {
      const path = recording.path;
      const bytes = readFileSync(path);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });

      let sessionId: number | null = null;
      let rawFile: string | null = null;
      try {
        const staged = await stageIbtUpload(
          body,
          "driven.ibt",
          bytes.byteLength,
        );
        expect(staged.token).not.toBeNull();
        expect(staged.preview.candidateLapCount).toBe(1);

        const imported = await commitStagedIbt(staged.token!);
        expect(imported.packetCount).toBe(6);
        expect(imported.laps).toHaveLength(1);
        expect(imported.laps[0]).toMatchObject({
          lapNumber: 2,
          carId: importedIdentity.carId,
          trackId: importedIdentity.trackId,
        });
        expect(
          await getDiscoveredCarName("iracing", importedIdentity.carId),
        ).toBe(importedIdentity.carName);
        expect(
          await getDiscoveredTrackName("iracing", importedIdentity.trackId),
        ).toBe(importedIdentity.trackName);
        expect(iracingAdapter.getCarName(importedIdentity.carId)).toBe(
          importedIdentity.carName,
        );
        expect(iracingAdapter.getTrackName(importedIdentity.trackId)).toBe(
          importedIdentity.trackName,
        );

        sessionId = imported.laps[0].sessionId;
        const [stored] = await getLapsRaw([imported.laps[0].lapId]);
        rawFile = stored?.rawFile ?? null;
        expect(rawFile).toEndWith(".bin");
        expect(rawFile ? existsSync(rawFile) : false).toBe(true);
      } finally {
        if (sessionId !== null) await deleteSession(sessionId);
        if (rawFile) rmSync(rawFile, { force: true });
        await db
          .delete(discoveredCars)
          .where(
            and(
              eq(discoveredCars.gameId, "iracing"),
              eq(discoveredCars.ordinal, importedIdentity.carId),
            ),
          )
          .run();
        await db
          .delete(discoveredTracks)
          .where(
            and(
              eq(discoveredTracks.gameId, "iracing"),
              eq(discoveredTracks.ordinal, importedIdentity.trackId),
            ),
          )
          .run();
      }
    } finally {
      recording.cleanup();
    }
  });

  test("rejects an IBT preview containing only an initial partial lap", async () => {
    const recording = createRecording();
    try {
      const preview = await previewIbtFile(recording.path);

      expect(preview.canImport).toBe(false);
      expect(preview.candidateLapCount).toBe(0);
      expect(preview.reason).toContain("No complete laps");
    } finally {
      recording.cleanup();
    }
  });
});
