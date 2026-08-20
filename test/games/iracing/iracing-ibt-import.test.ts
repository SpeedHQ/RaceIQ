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
import { getDiscoveredCarName } from "../../../server/db/discovered-cars";
import { getDiscoveredTrackName } from "../../../server/db/discovered-tracks";
import { db } from "../../../server/db/index";
import { discoveredCars, discoveredTracks } from "../../../server/db/schema";
import {
  getLapById,
  getLapsRaw,
} from "../../../server/db/lap-read-queries";
import { deleteSession } from "../../../server/db/session-queries";
import {
  commitStagedIbt,
  previewIbtFile,
  stageIbtUpload,
} from "../../../server/games/iracing/import-ibt";
import { initServerGameAdapters } from "../../../server/games/init";
import { iracingAdapter } from "../../../shared/games/iracing";
import { initGameAdapters } from "../../../shared/games/init";
import {
  createRecording,
  drivenRows,
} from "../../support/games/iracing-ibt";
import type { SyntheticIdentity } from "../../support/games/iracing-ibt";

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
          carOrdinal: importedIdentity.carId,
          trackOrdinal: importedIdentity.trackId,
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
        const savedLap = await getLapById(imported.laps[0].lapId);
        expect(
          savedLap?.telemetry.some(
            (packet) => packet.PositionX !== 0 || packet.PositionZ !== 0,
          ),
        ).toBe(true);
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
