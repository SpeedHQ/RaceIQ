import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { getDiscoveredCarName } from "../../../server/db/discovered-cars";
import { getDiscoveredTrackName } from "../../../server/db/discovered-tracks";
import { db } from "../../../server/db/index";
import { discoveredCars, discoveredTracks, laps, sessions } from "../../../server/db/schema";
import { getLapsRaw } from "../../../server/db/lap-read-queries";
import { deleteSession } from "../../../server/db/session-queries";
import {
  buildIbtSourceChannelProfile,
  commitStagedIbt,
  composeIbtParserVersion,
  previewIbtFile,
  stageIbtUpload,
} from "../../../server/games/iracing/import-ibt";
import { sha256ContentHash } from "../../../server/session-capture/identity";
import { finalizeRecordingQualityGeneration } from "../../../server/lap-analysis/quality-generation";
import { initServerGameAdapters } from "../../../server/games/init";
import { iracingAdapter } from "../../../shared/games/iracing";
import { initGameAdapters } from "../../../shared/games/init";
import { createRecording, drivenRows } from "../../support/games/iracing-ibt";
import type { SyntheticIdentity } from "../../support/games/iracing-ibt";
import { TELEMETRY_PARSER_VERSIONS } from "../../../shared/telemetry/resolver/versions";

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
      expect(preview.ibtSchemaVersion).toBe(2);
      expect(preview.missingRaceIQVariables).toEqual(
        expect.arrayContaining([
          "Throttle",
          "Brake",
          "SteeringWheelAngle",
          "SteeringWheelAngleMax",
        ]),
      );
      expect(preview.maxSpeedMph).toBeGreaterThan(100);
    } finally {
      recording.cleanup();
    }
  });

  test("marks missing optional IBT controls as unavailable source evidence", async () => {
    const recording = createRecording("missing-controls.ibt", drivenRows());
    try {
      const preview = await previewIbtFile(recording.path);
      const profile = buildIbtSourceChannelProfile(preview);

      expect(profile.channels).toMatchObject({
        "inputs.accel": {
          treatment: "absent",
          mappingStatus: "unavailable",
          sourceChannels: [],
        },
        "inputs.brake": {
          treatment: "absent",
          mappingStatus: "unavailable",
          sourceChannels: [],
        },
        "inputs.steer": {
          treatment: "absent",
          mappingStatus: "unavailable",
          sourceChannels: [],
        },
      });
      expect(profile.channels["motion.speed"]).toBeUndefined();
    } finally {
      recording.cleanup();
    }
  });

  test("composes semantic parser identity with IBT schema and tick rate", () => {
    const ibt = { ibtSchemaVersion: 2, tickRate: 60 };
    const current = composeIbtParserVersion(
      ibt,
      TELEMETRY_PARSER_VERSIONS.iracing,
    );
    const changed = composeIbtParserVersion(
      ibt,
      `${TELEMETRY_PARSER_VERSIONS.iracing}-next`,
    );

    expect(current).toBe(
      `${TELEMETRY_PARSER_VERSIONS.iracing}+iracing-ibt@2:60hz`,
    );
    expect(changed).not.toBe(current);
  });

  test("commits a staged IBT through the normal pipeline and canonical recorder", async () => {
    const importedIdentity: SyntheticIdentity = {
      trackId: 910_099,
      trackName: "Imported Raceway",
      carId: 910_042,
      carName: "Imported GT3",
    };
    const recording = createRecording("driven.ibt", drivenRows(), importedIdentity);
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
        const staged = await stageIbtUpload(body, "driven.ibt", bytes.byteLength);
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
        expect(await getDiscoveredCarName("iracing", importedIdentity.carId)).toBe(importedIdentity.carName);
        expect(await getDiscoveredTrackName("iracing", importedIdentity.trackId)).toBe(importedIdentity.trackName);
        expect(iracingAdapter.getCarName(importedIdentity.carId)).toBe(importedIdentity.carName);
        expect(iracingAdapter.getTrackName(importedIdentity.trackId)).toBe(importedIdentity.trackName);

        sessionId = imported.laps[0].sessionId;
        const [stored] = await getLapsRaw([imported.laps[0].lapId]);
        rawFile = stored?.rawFile ?? null;
        expect(rawFile).toEndWith(".bin");
        const [qualityRow] = await db
          .select({
            source: sessions.source,
            parserVersion: sessions.parserVersion,
            sourceChannelProfile: sessions.sourceChannelProfile,
            recordingQuality: sessions.recordingQuality,
            quality: laps.quality,
            eligibility: laps.eligibility,
            qualityGeneration: laps.qualityGeneration,
          })
          .from(laps)
          .innerJoin(sessions, eq(laps.sessionId, sessions.id))
          .where(eq(laps.id, imported.laps[0].lapId));
        expect(qualityRow?.source).toBe("iracing-ibt");
        expect(qualityRow?.recordingQuality?.sourceKind).toBe("iracing-ibt");
        expect(qualityRow?.quality?.sourceKind).toBe("iracing-ibt");
        expect(qualityRow?.parserVersion).toBe(
          composeIbtParserVersion(imported.preview),
        );
        expect(qualityRow?.sourceChannelProfile?.channels).toMatchObject({
          "inputs.accel": { mappingStatus: "unavailable" },
          "inputs.brake": { mappingStatus: "unavailable" },
          "inputs.steer": { mappingStatus: "unavailable" },
        });
        expect(
          qualityRow?.quality?.channelQuality.find(
            ({ semanticId }) => semanticId === "inputs.accel",
          ),
        ).toMatchObject({ mappingStatus: "unavailable", observedCount: 0 });
        expect(
          qualityRow?.quality?.channelQuality.find(
            ({ semanticId }) => semanticId === "inputs.brake",
          ),
        ).toMatchObject({ mappingStatus: "unavailable", observedCount: 0 });
        expect(
          qualityRow?.quality?.channelQuality.find(
            ({ semanticId }) => semanticId === "inputs.steer",
          ),
        ).toMatchObject({ mappingStatus: "unavailable", observedCount: 0 });
        expect(
          qualityRow?.quality?.channelQuality.find(
            ({ semanticId }) => semanticId === "motion.speed",
          )?.mappingStatus,
        ).not.toBe("unavailable");
        expect(qualityRow?.eligibility?.["corner-trace"].status).toBe(
          "ineligible",
        );
        expect(qualityRow?.eligibility?.["ml-training"].status).toBe(
          "ineligible",
        );
        expect(qualityRow?.eligibility?.["official-timing"].status).not.toBe("unknown");
        expect(qualityRow?.qualityGeneration ?? null).toBe(qualityRow?.quality?.provenance.outputGeneration ?? null);
        const expectedSourceGeneration = sha256ContentHash(bytes);
        expect(qualityRow?.recordingQuality?.archiveVerification.sourceGeneration).toBe(expectedSourceGeneration);
        expect(qualityRow?.recordingQuality?.provenance.sourceGeneration).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(qualityRow?.quality?.provenance.sourceGeneration).toMatch(/^sha256:[0-9a-f]{64}$/);
        if (!qualityRow?.recordingQuality) {
          throw new Error("Imported IBT recording quality was not persisted");
        }
        const changedParserQuality = finalizeRecordingQualityGeneration({
          ...qualityRow.recordingQuality,
          versionIdentity: {
            ...qualityRow.recordingQuality.versionIdentity,
            parserVersion: composeIbtParserVersion(
              imported.preview,
              `${TELEMETRY_PARSER_VERSIONS.iracing}-next`,
            ),
          },
        });
        expect(
          changedParserQuality.archiveVerification.sourceGeneration,
        ).toBe(expectedSourceGeneration);
        expect(changedParserQuality.provenance.sourceGeneration).not.toBe(
          qualityRow.recordingQuality.provenance.sourceGeneration,
        );
        expect(rawFile ? existsSync(rawFile) : false).toBe(true);
      } finally {
        if (sessionId !== null) await deleteSession(sessionId);
        if (rawFile) rmSync(rawFile, { force: true });
        await db
          .delete(discoveredCars)
          .where(and(eq(discoveredCars.gameId, "iracing"), eq(discoveredCars.ordinal, importedIdentity.carId)))
          .run();
        await db
          .delete(discoveredTracks)
          .where(and(eq(discoveredTracks.gameId, "iracing"), eq(discoveredTracks.ordinal, importedIdentity.trackId)))
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
