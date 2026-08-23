import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { GameId } from "../../shared/games/ids";
import { initGameAdapters } from "../../shared/games/init";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { getActiveAnalysisReceipt } from "../../server/db/analysis-receipt-queries";
import { db } from "../../server/db";
import { sessionResults, sessions } from "../../server/db/schema";
import {
  deleteSession,
  insertSession,
  updateSessionRawFile,
} from "../../server/db/session-queries";
import { getSessionResult } from "../../server/db/session-result-queries";
import { getSessionTelemetry } from "../../server/db/telemetry-replay-storage";
import { readIRacingFrames } from "../../server/games/iracing/recorder";
import { initServerGameAdapters } from "../../server/games/init";
import { canonicalPacketContentHash } from "../../server/race-results/canonical-input";
import { RACE_RESULT_PROCESSOR_ID } from "../../server/race-results/constants";
import {
  reconcileSessionResult,
  reconcileStaleSessionResult,
} from "../../server/race-results/reconcile";
import { SessionRecorder } from "../../server/session-capture/recorder";
import { reprocessSession } from "../../server/session-capture/reprocess";
import { sha256ContentHash } from "../../server/session-capture/identity";
import { getRecordingFixture } from "../support/recordings/fixtures";

initGameAdapters();
initServerGameAdapters();

async function createCapturedSession(
  gameId: GameId,
  frames: Iterable<Buffer>,
): Promise<{ directory: string; sessionId: number }> {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-reconcile-generation-"));
  const rawPath = join(directory, "session.bin");
  const recorder = new SessionRecorder();
  recorder.start(rawPath);
  recorder.writeMetaFrame();
  for (const frame of frames) recorder.writeRecord(frame);
  await recorder.stop();

  const sessionId = await insertSession(1, 1, gameId, "race");
  await updateSessionRawFile(sessionId, rawPath, "stale-detector");
  return { directory, sessionId };
}

test("canonical packet identity preserves replay v1 framing", () => {
  const packets = [
    { SessionID: 7, TimestampMS: 100 },
    { SessionID: 7, TimestampMS: 200 },
  ] as unknown as TelemetryPacket[];
  const framed = Buffer.from(packets.map((packet) => JSON.stringify(packet)).join("\n"));

  expect(canonicalPacketContentHash(packets)).toBe(sha256ContentHash(framed));
});

test("pre-receipt reconciliation keeps writing pending live generation results", async () => {
  const fixture = await createCapturedSession("fm-2023", []);
  try {
    await reconcileSessionResult(
      fixture.sessionId,
      "fm-2023",
      "analysis-generation:pending-test",
    );

    const [active, result] = await Promise.all([
      getActiveAnalysisReceipt({
        sessionId: fixture.sessionId,
        artifactSetType: "session_analysis",
      }),
      getSessionResult(fixture.sessionId, "fm-2023"),
    ]);
    expect(active).toBeUndefined();
    expect(result?.analysisGenerationId).toBe("analysis-generation:pending-test");
  } finally {
    await deleteSession(fixture.sessionId);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("processor drift under an active receipt rebuilds instead of rewriting its result", async () => {
  const recording = getRecordingFixture("iracing-road-america-gt3.bin.gz");
  if (!recording) throw new Error("Required recording fixture is missing");
  const fixture = await createCapturedSession("iracing", readIRacingFrames(recording));
  try {
    const first = await reprocessSession(fixture.sessionId);
    await db
      .update(sessionResults)
      .set({ processorVersion: "stale-race-result-processor" })
      .where(eq(sessionResults.sessionId, fixture.sessionId))
      .run();

    await reconcileSessionResult(fixture.sessionId, "iracing");

    const [active, result] = await Promise.all([
      getActiveAnalysisReceipt({
        sessionId: fixture.sessionId,
        artifactSetType: "session_analysis",
      }),
      getSessionResult(fixture.sessionId, "iracing"),
    ]);
    expect(active?.generationId).not.toBe(first.analysisGenerationId);
    expect(result?.analysisGenerationId).toBe(active?.generationId);
    expect(result?.processorVersion).toBe(RACE_RESULT_PROCESSOR_ID);
  } finally {
    await deleteSession(fixture.sessionId);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("stale timeline reconciliation leaves reprocessed generation current", async () => {
  const recording = getRecordingFixture("iracing-road-america-gt3.bin.gz");
  if (!recording) throw new Error("Required recording fixture is missing");
  const fixture = await createCapturedSession("iracing", readIRacingFrames(recording));
  try {
    const first = await reprocessSession(fixture.sessionId);
    await db
      .update(sessions)
      .set({ lapDetectorVersion: "stale-detector" })
      .where(eq(sessions.id, fixture.sessionId))
      .run();

    await reconcileStaleSessionResult(fixture.sessionId, "iracing");

    const [active, result, packets] = await Promise.all([
      getActiveAnalysisReceipt({
        sessionId: fixture.sessionId,
        artifactSetType: "session_analysis",
      }),
      getSessionResult(fixture.sessionId, "iracing"),
      getSessionTelemetry(fixture.sessionId, "iracing"),
    ]);
    expect(active?.generationId).not.toBe(first.analysisGenerationId);
    expect(result?.analysisGenerationId).toBe(active?.generationId);
    expect(result?.provenance.canonicalInput?.contentHash ?? null).toBe(
      canonicalPacketContentHash(packets),
    );
  } finally {
    await deleteSession(fixture.sessionId);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
