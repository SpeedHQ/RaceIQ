import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";

import type { GameId } from "../../shared/games/ids";
import { ELIGIBILITY_POLICY_VERSION, LOCAL_PLAYER_EVIDENCE, QUALITY_CONFIG_VERSION, QUALITY_SCHEMA_VERSION, type RecordingQualitySummary } from "../../shared/racing/quality/contracts";
import { RecordingQualityAccumulator } from "../../shared/racing/quality/measure";
import { db } from "../../server/db";
import { laps, sessions } from "../../server/db/schema";
import { initServerGameAdapters } from "../../server/games/init";
import { LAP_DETECTOR_ID } from "../../server/lap-detection/detector";
import { finalizeRecordingQualityGeneration } from "../../server/lap-analysis/quality-generation";
import { getQualityRebuildStatus, rebuildSessionEligibility } from "../../server/lap-analysis/quality-rebuild";
import { sha256ContentHash } from "../../server/session-capture/identity";
import { initGameAdapters } from "../../shared/games/init";
import { qualityPackets, TEST_VERSION_IDENTITY } from "../support/lap-analysis/quality-model";

initGameAdapters();
initServerGameAdapters();

function recordingQuality(): RecordingQualitySummary {
  const accumulator = new RecordingQualityAccumulator("raceiq-raw", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
  const packets = qualityPackets(12);
  for (const packet of packets) accumulator.observe(packet);
  accumulator.observe(packets[packets.length - 1]!);
  return finalizeRecordingQualityGeneration(
    accumulator.finalize("reprocessed", {
      state: "verified",
      sourceGeneration: `sha256:${"a".repeat(64)}`,
    }),
  );
}

function replayMeasurements(summary: RecordingQualitySummary) {
  const { provenance: _provenance, facts, ...measurements } = summary;
  return {
    ...measurements,
    facts: facts.map(({ provenance: _factProvenance, ...fact }) => fact),
  };
}

describe("quality rebuild detector identity", () => {
  const createdSessionIds: number[] = [];
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "raceiq-quality-rebuild-"));
  });

  afterEach(async () => {
    if (createdSessionIds.length > 0) {
      await db.delete(laps).where(inArray(laps.sessionId, createdSessionIds)).run();
      await db.delete(sessions).where(inArray(sessions.id, createdSessionIds)).run();
      createdSessionIds.length = 0;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  async function insertSession(overrides: Partial<typeof sessions.$inferInsert> = {}): Promise<{ id: number; quality: RecordingQualitySummary }> {
    const quality = overrides.recordingQuality ?? recordingQuality();
    const row = await db
      .insert(sessions)
      .values({
        carOrdinal: 1,
        trackOrdinal: 1,
        gameId: "fm-2023",
        lapDetectorVersion: LAP_DETECTOR_ID,
        recordingQuality: quality,
        qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
        qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
        qualityConfigVersion: QUALITY_CONFIG_VERSION,
        qualityGeneration: quality.provenance.outputGeneration,
        ...overrides,
      })
      .returning({ id: sessions.id })
      .get();
    createdSessionIds.push(row.id);
    return { id: row.id, quality };
  }

  function rawCapture(name: string, bytes = Buffer.from("capture")): string {
    const path = join(testDir, name);
    writeFileSync(path, bytes);
    return path;
  }

  test("marks legacy current quality without a receipt unavailable when source is absent", async () => {
    const { id } = await insertSession();

    expect(await getQualityRebuildStatus(id)).toMatchObject({
      sessionId: id,
      action: "unavailable",
      currentDetectorId: LAP_DETECTOR_ID,
      rawAvailable: false,
      stale: {
        detector: false,
        schema: false,
        policy: false,
        configuration: false,
        source: false,
      },
      analysisStatus: {
        status: "stale_source_missing",
        staleReasons: ["receipt_missing", "source_unavailable"],
      },
    });
  });

  test("marks legacy policy-only quality without a receipt unavailable when source is absent", async () => {
    const { id } = await insertSession({
      qualityPolicyVersion: "stale-policy",
    });

    const before = await getQualityRebuildStatus(id);
    expect(before.action).toBe("unavailable");
    expect(before.stale).toEqual({
      detector: false,
      schema: false,
      policy: true,
      configuration: false,
      source: false,
    });

    const rebuilt = await rebuildSessionEligibility(id);
    expect(rebuilt.action).toBe("unavailable");
  });

  test("routes legacy current quality with source bytes but no receipt through full reprocess", async () => {
    const bytes = Buffer.from("unchanged-capture");
    const generation = sha256ContentHash(bytes);
    const canonicalQuality: RecordingQualitySummary = {
      ...recordingQuality(),
      canonicalVerification: {
        state: "verified",
        sourceGeneration: generation,
      },
    };
    const sourceQuality: RecordingQualitySummary = {
      ...recordingQuality(),
      archiveVerification: {
        state: "verified",
        sourceGeneration: generation,
      },
    };

    for (const [name, quality] of [
      ["canonical.bin", canonicalQuality],
      ["legacy-source.bin", sourceQuality],
    ] as const) {
      const { id } = await insertSession({
        rawFile: rawCapture(name, bytes),
        recordingQuality: quality,
      });
      const status = await getQualityRebuildStatus(id);
      expect(status.action).toBe("reprocess");
      expect(status.rawAvailable).toBe(true);
      expect(status.stale.source).toBe(false);
      expect(status.analysisStatus).toMatchObject({
        status: "stale_rebuild_available",
        staleReasons: ["receipt_missing"],
      });
    }
  });

  test("requires reprocessing when retained bytes change", async () => {
    const original = Buffer.from("original-capture");
    const changed = Buffer.from("changed-capture");
    const quality: RecordingQualitySummary = {
      ...recordingQuality(),
      canonicalVerification: {
        state: "verified",
        sourceGeneration: sha256ContentHash(original),
      },
    };
    const { id } = await insertSession({
      rawFile: rawCapture("changed.bin", changed),
      recordingQuality: quality,
    });

    const status = await getQualityRebuildStatus(id);
    expect(status.action).toBe("reprocess");
    expect(status.rawAvailable).toBe(true);
    expect(status.stale.source).toBe(true);
  });

  test("reports unavailable for missing, unreadable, and corrupt retained bytes", async () => {
    const missing = join(testDir, "missing.bin");
    const unreadable = join(testDir, "capture-directory");
    mkdirSync(unreadable);
    const corrupt = rawCapture("corrupt.bin.gz", Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff]));

    for (const rawFile of [missing, unreadable, corrupt]) {
      const { id } = await insertSession({ rawFile });
      const status = await getQualityRebuildStatus(id);
      expect(status.action).toBe("unavailable");
      expect(status.rawAvailable).toBe(false);
      expect(status.stale.source).toBe(true);
    }
  });

  test("requires reprocessing for mismatched or missing stored detector identity", async () => {
    for (const detectorVersion of ["obsolete-detector", null]) {
      const { id } = await insertSession({
        lapDetectorVersion: detectorVersion,
        rawFile: rawCapture(`capture-${detectorVersion ?? "missing"}.bin`),
      });
      const status = await getQualityRebuildStatus(id);
      expect(status.action).toBe("reprocess");
      expect(status.currentDetectorId).toBe(LAP_DETECTOR_ID);
      expect(status.stale.detector).toBe(true);
    }
  });

  test("returns unavailable when detector measurements are stale without raw capture", async () => {
    const { id } = await insertSession({
      lapDetectorVersion: "obsolete-detector",
    });

    const status = await getQualityRebuildStatus(id);
    expect(status.action).toBe("unavailable");
    expect(status.rawAvailable).toBe(false);
    expect(status.stale.detector).toBe(true);
  });

  test("returns unavailable when game adapter identity cannot be resolved", async () => {
    const { id } = await insertSession({
      gameId: "unregistered-test-game" as GameId,
      lapDetectorVersion: "unknown-detector",
      rawFile: rawCapture("unregistered.bin"),
    });

    const status = await getQualityRebuildStatus(id);
    expect(status.action).toBe("unavailable");
    expect(status.rawAvailable).toBe(true);
    expect(status.currentDetectorId).toBeNull();
    expect(status.stale.detector).toBe(true);
  });

  test("does not hide detector staleness behind a policy-only rebuild", async () => {
    const { id, quality } = await insertSession({
      lapDetectorVersion: "obsolete-detector",
      qualityPolicyVersion: "stale-policy",
      rawFile: rawCapture("detector-and-policy-stale.bin"),
    });

    const status = await rebuildSessionEligibility(id);
    expect(status.action).toBe("reprocess");
    expect(status.stale.detector).toBe(true);
    expect(status.stale.policy).toBe(true);
    const row = await db
      .select({
        recordingQuality: sessions.recordingQuality,
        qualityPolicyVersion: sessions.qualityPolicyVersion,
      })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    expect(row?.qualityPolicyVersion).toBe("stale-policy");
    expect(replayMeasurements(row!.recordingQuality!)).toEqual(replayMeasurements(quality));
  });
});
