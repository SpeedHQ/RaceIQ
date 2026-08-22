import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { asc, eq } from "drizzle-orm";
import { initGameAdapters } from "../../shared/games/init";
import { type RaceEvent, type RaceEventType } from "../../shared/racing/events/contracts";
import { LOCAL_PLAYER_EVIDENCE } from "../../shared/racing/quality/contracts";
import { db } from "../../server/db";
import { analysisReceipts, canonicalArchiveJobs, canonicalArchives, laps, raceEvents, sessionResults, sessionRunEvidence, sessionRunLaps, sessionRuns, sessions } from "../../server/db/schema";
import { deleteSession } from "../../server/db/session-queries";
import { claimCanonicalArchiveJob, enqueueCanonicalArchiveJob } from "../../server/db/canonical-archive-queries";
import { listSessionRaceEvents } from "../../server/db/race-event-queries";
import { initServerGameAdapters } from "../../server/games/init";
import { getServerGame } from "../../server/games/registry";
import { readIRacingFrames } from "../../server/games/iracing/recorder";
import { rebuildRaceEventTimeline, type RebuildRaceEventTimelineInput } from "../../server/race-events/rebuild";
import { DatabaseRaceEventStore } from "../../server/race-events/store";
import { buildCanonicalArchive } from "../../server/session-capture/canonical-archive";
import { loadRawCaptureIdentity } from "../../server/session-capture/identity";
import { ImportCaptureAdapter, IncompleteImportError, importSessionFrames } from "../../server/session-capture/import-pipeline";
import { reprocessSession } from "../../server/session-capture/reprocess";
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { currentTelemetryVersionIdentity, NullSessionRecorderAdapter, NullWsAdapter, RealDbAdapter } from "../../server/telemetry/pipeline-ports";
import { resolveDataDir } from "../../server/runtime/config/data-dir";
initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

interface FixtureFrame {
  frame: Buffer;
  rawByteOffset: number;
}

const FIXTURE = resolve(import.meta.dir, "../artifacts/sessions/iracing-daytona-am-vantage-gt3-pit.bin.gz");
const VERSION_IDENTITY = currentTelemetryVersionIdentity("iracing");
const SOURCE_VERIFICATION = {
  state: "verified" as const,
  sourceGeneration: "sha256:replay-parity-source",
};
const CANONICAL_VERIFICATION = {
  state: "verified" as const,
  sourceGeneration: "sha256:replay-parity-canonical",
};
const TRANSPORT_EVENT_TYPES: Partial<Record<RaceEventType, true>> = {
  source_connected: true,
  source_disconnected: true,
  source_stale: true,
  source_recovered: true,
  storage_drop: true,
  storage_failure: true,
};
const FIXTURE_LANDMARKS = [
  "source_connected",
  "session_started",
  "lap_completed",
  "pit_entry",
  "pit_service_started",
  "fuel_service_observed",
  "repair_service_observed",
  "pit_service_completed",
  "pit_exit",
] as const satisfies readonly RaceEventType[];

function fixtureFrames(): FixtureFrame[] {
  return readIRacingFrames(FIXTURE).map((frame, rawByteOffset) => ({
    frame,
    rawByteOffset,
  }));
}

function normalizedEvent(event: RaceEvent) {
  const {
    createdAt: _createdAt,
    receivedAtMs: _receivedAtMs,
    lapId: _lapId,
    sourceKind: _sourceKind,
    sourceGeneration: _sourceGeneration,
    analysisGenerationId: _analysisGenerationId,
    ...semantic
  } = event;
  return semantic;
}

function crossSessionEvent(event: RaceEvent) {
  const {
    sessionId: _sessionId,
    eventId: _eventId,
    lifecycleId: _lifecycleId,
    linkedEventId: _linkedEventId,
    contentHash: _contentHash,
    eventOrder: _eventOrder,
    ...semantic
  } = normalizedEvent(event);
  return semantic;
}

function orderedCrossSessionEvents(events: readonly RaceEvent[]) {
  return events.map(crossSessionEvent).sort((left, right) => left.timelineEpoch - right.timelineEpoch || left.sequence - right.sequence || JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function sessionBoundEvents(events: readonly RaceEvent[]): RaceEvent[] {
  const sessionTimes = events
    .filter((event) => TRANSPORT_EVENT_TYPES[event.eventType] !== true)
    .flatMap((event) => [event.sourceTimeMs, event.sourceEndTimeMs])
    .filter((value): value is number => value != null);
  if (sessionTimes.length === 0) return [...events];
  const start = Math.min(...sessionTimes);
  const end = Math.max(...sessionTimes);
  return events.filter((event) => {
    if (TRANSPORT_EVENT_TYPES[event.eventType] !== true) return true;
    if (event.sourceTimeMs == null || event.sourceEndTimeMs == null) return false;
    return event.sourceEndTimeMs >= start && event.sourceTimeMs <= end;
  });
}

async function readAllEvents(sessionId: number): Promise<RaceEvent[]> {
  const events: RaceEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = await listSessionRaceEvents(sessionId, cursor == null ? { limit: 1_000 } : { cursor, limit: 1_000 });
    events.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor != null);
  return events;
}

function semanticQuality<T>(quality: T): T {
  if (!quality || typeof quality !== "object") return quality;
  const {
    provenance: _provenance,
    sourceKind: _sourceKind,
    archiveVerification: _archiveVerification,
    canonicalVerification: _canonicalVerification,
    endReason: _endReason,
    ...semantic
  } = quality as Record<string, unknown>;
  return semantic as T;
}

function withoutGenerationIdentities<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(withoutGenerationIdentities) as T;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "sourceGeneration" && key !== "outputGeneration")
      .map(([key, nested]) => [key, withoutGenerationIdentities(nested)]),
  ) as T;
}

function eligibilityGenerations(lapRows: readonly (typeof laps.$inferSelect)[]) {
  const generations: Array<{
    lapNumber: number;
    policyId: string;
    sourceGeneration: string | null;
    outputGeneration: string | null;
    qualityOutputGeneration: string | null;
  }> = [];
  for (const lap of lapRows) {
    if (!lap.eligibility || typeof lap.eligibility !== "object") continue;
    for (const [policyId, decision] of Object.entries(lap.eligibility as Record<string, unknown>)) {
      if (!decision || typeof decision !== "object") continue;
      const provenance = (decision as Record<string, unknown>).provenance;
      if (!provenance || typeof provenance !== "object") continue;
      const values = provenance as Record<string, unknown>;
      generations.push({
        lapNumber: lap.lapNumber,
        policyId,
        sourceGeneration: typeof values.sourceGeneration === "string" ? values.sourceGeneration : null,
        outputGeneration: typeof values.outputGeneration === "string" ? values.outputGeneration : null,
        qualityOutputGeneration: lap.quality?.provenance.outputGeneration ?? null,
      });
    }
  }
  return generations;
}

function semanticLap(lap: typeof laps.$inferSelect) {
  const {
    id: _id,
    analysisGenerationId: _analysisGenerationId,
    qualityGeneration: _qualityGeneration,
    rawByteOffset: _rawByteOffset,
    rawFrameCount: _rawFrameCount,
    createdAt: _createdAt,
    quality,
    eligibility,
    ...semantic
  } = lap;
  return {
    ...semantic,
    quality: withoutGenerationIdentities(quality),
    eligibility: withoutGenerationIdentities(eligibility),
  };
}

function semanticRun(run: typeof sessionRuns.$inferSelect) {
  const {
    analysisGenerationId: _analysisGenerationId,
    sourceGeneration: _sourceGeneration,
    startLapId: _startLapId,
    endLapId: _endLapId,
    createdAt: _createdAt,
    ...semantic
  } = run;
  return semantic;
}

function semanticResult(result: typeof sessionResults.$inferSelect | undefined) {
  if (!result) return result;
  const {
    analysisGenerationId: _analysisGenerationId,
    provenance: _provenance,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...semantic
  } = result;
  return semantic;
}

async function persistedSessionParity(sessionId: number) {
  const [session, lapRows, runRows, memberships, evidence, result] = await Promise.all([
    db.select({ recordingQuality: sessions.recordingQuality }).from(sessions).where(eq(sessions.id, sessionId)).get(),
    db.select().from(laps).where(eq(laps.sessionId, sessionId)).orderBy(asc(laps.id)).all(),
    db.select().from(sessionRuns).where(eq(sessionRuns.sessionId, sessionId)).orderBy(asc(sessionRuns.runId)).all(),
    db
      .select({
        runId: sessionRunLaps.runId,
        lapEventId: sessionRunLaps.lapEventId,
        lapNumber: sessionRunLaps.lapNumber,
        ordinal: sessionRunLaps.ordinal,
        entryEventId: sessionRunLaps.entryEventId,
        exitEventId: sessionRunLaps.exitEventId,
      })
      .from(sessionRunLaps)
      .innerJoin(sessionRuns, eq(sessionRuns.runId, sessionRunLaps.runId))
      .where(eq(sessionRuns.sessionId, sessionId))
      .orderBy(asc(sessionRunLaps.runId), asc(sessionRunLaps.ordinal), asc(sessionRunLaps.lapEventId))
      .all(),
    db
      .select({
        runId: sessionRunEvidence.runId,
        eventId: sessionRunEvidence.eventId,
        role: sessionRunEvidence.role,
      })
      .from(sessionRunEvidence)
      .innerJoin(sessionRuns, eq(sessionRuns.runId, sessionRunEvidence.runId))
      .where(eq(sessionRuns.sessionId, sessionId))
      .orderBy(asc(sessionRunEvidence.runId), asc(sessionRunEvidence.eventId), asc(sessionRunEvidence.role))
      .all(),
    db.select().from(sessionResults).where(eq(sessionResults.sessionId, sessionId)).get(),
  ]);
  const events = sessionBoundEvents(await readAllEvents(sessionId));
  return {
    events,
    laps: lapRows.map(semanticLap),
    runs: runRows.map(semanticRun),
    memberships,
    evidence,
    result: semanticResult(result),
    quality: semanticQuality(session?.recordingQuality),
    sourceGenerations: {
      events: [...new Set(events.map(({ sourceGeneration }) => sourceGeneration))],
      runs: [...new Set(runRows.map(({ sourceGeneration }) => sourceGeneration))],
      quality: session?.recordingQuality?.provenance.sourceGeneration,
      archiveQuality: session?.recordingQuality?.archiveVerification.sourceGeneration,
      canonicalQuality: session?.recordingQuality?.canonicalVerification?.sourceGeneration,
    },
    eligibilityGenerations: eligibilityGenerations(lapRows),
    stableIds: {
      events: events.map(({ eventId }) => eventId),
      eventContent: events.map(({ contentHash }) => contentHash),
      runs: runRows.map(({ runId }) => runId),
      runContent: runRows.map(({ contentHash }) => contentHash),
      memberships: memberships.map(({ runId, lapEventId }) => `${runId}:${lapEventId}`),
      evidence: evidence.map(({ runId, eventId, role }) => `${runId}:${eventId}:${role}`),
    },
  };
}

async function durableImportArtifacts() {
  const [sessionRows, lapRows, eventRows, runRows, membershipRows, evidenceRows, resultRows, receiptRows, archiveRows, archiveJobRows] = await Promise.all([
    db.select({ id: sessions.id }).from(sessions).all(),
    db.select({ id: laps.id }).from(laps).all(),
    db.select({ eventId: raceEvents.eventId }).from(raceEvents).all(),
    db.select({ runId: sessionRuns.runId }).from(sessionRuns).all(),
    db.select({ runId: sessionRunLaps.runId, lapEventId: sessionRunLaps.lapEventId }).from(sessionRunLaps).all(),
    db.select({ runId: sessionRunEvidence.runId, eventId: sessionRunEvidence.eventId }).from(sessionRunEvidence).all(),
    db.select({ id: sessionResults.id }).from(sessionResults).all(),
    db.select({ generationId: analysisReceipts.generationId }).from(analysisReceipts).all(),
    db.select({ archiveId: canonicalArchives.archiveId }).from(canonicalArchives).all(),
    db.select({ jobId: canonicalArchiveJobs.jobId }).from(canonicalArchiveJobs).all(),
  ]);
  return {
    sessions: sessionRows.length,
    laps: lapRows.length,
    events: eventRows.length,
    runs: runRows.length,
    memberships: membershipRows.length,
    evidence: evidenceRows.length,
    results: resultRows.length,
    receipts: receiptRows.length,
    archives: archiveRows.length,
    archiveJobs: archiveJobRows.length,
  };
}

function rawImportFiles(): string[] {
  const directory = resolve(resolveDataDir(), "sessions", "iracing");
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

async function runLivePath(frames: readonly FixtureFrame[]): Promise<{ sessionId: number; events: RaceEvent[] }> {
  const capture = new ImportCaptureAdapter({ db: new RealDbAdapter() });
  const pipeline = new LiveTelemetryPipeline(capture, new NullWsAdapter(), {
    bypassPacketRateFilter: true,
    skipHistorySeeding: true,
    skipDevState: true,
    recorder: new NullSessionRecorderAdapter(),
    raceEventStore: new DatabaseRaceEventStore(),
    sourceKind: "raceiq-raw",
    participant: LOCAL_PLAYER_EVIDENCE,
    versionIdentity: VERSION_IDENTITY,
    sourceArchiveVerification: SOURCE_VERIFICATION,
  });
  const game = getServerGame("iracing");
  const parserState = game.createParserState?.() ?? null;
  for (const { frame } of frames) {
    const packet = game.tryParse(frame, parserState);
    if (packet) await pipeline.processPacket(packet, frame);
  }
  await pipeline.finalizeCurrentSession();
  await capture.waitForPendingLapWrites();
  const sessionIds = [...capture.sessionIds];
  expect(sessionIds).toHaveLength(1);
  const sessionId = sessionIds[0]!;
  return { sessionId, events: await readAllEvents(sessionId) };
}

async function runImportPath(frames: readonly FixtureFrame[]): Promise<{ sessionId: number; events: RaceEvent[] }> {
  const imported = await importSessionFrames(
    frames.map(({ frame }) => frame),
    "iracing",
    {
      sourceKind: "raceiq-raw",
      participant: LOCAL_PLAYER_EVIDENCE,
      versionIdentity: VERSION_IDENTITY,
      sourceArchiveVerification: SOURCE_VERIFICATION,
    },
  );
  expect(imported.sessionIds).toHaveLength(1);
  const sessionId = imported.sessionIds[0]!;
  return { sessionId, events: await readAllEvents(sessionId) };
}

async function rebuildForSession(sessionId: number, frames: readonly FixtureFrame[]): Promise<RaceEvent[]> {
  return (
    await rebuildRaceEventTimeline({
      sessionId,
      analysisGenerationId: "analysis-generation:import-replay-parity",
      gameId: "iracing",
      frames,
      sourceKind: "raceiq-raw",
      participant: LOCAL_PLAYER_EVIDENCE,
      versionIdentity: VERSION_IDENTITY,
      sourceVerification: SOURCE_VERIFICATION,
      canonicalVerification: CANONICAL_VERIFICATION,
    })
  ).events;
}

function assertFixtureLandmarks(events: readonly RaceEvent[]): void {
  const eventTypes = events.map(({ eventType }) => eventType);
  for (const eventType of FIXTURE_LANDMARKS) {
    expect(eventTypes).toContain(eventType);
  }
  const pitEntry = events.find(({ eventType }) => eventType === "pit_entry");
  expect(pitEntry).toBeDefined();
  expect(pitEntry!.lifecycleId).not.toBeNull();
  const pitVisit = events.filter(({ lifecycleId }) => lifecycleId === pitEntry!.lifecycleId);
  expect(pitVisit.map(({ eventType }) => eventType)).toEqual([
    "pit_entry",
    "pit_stall_arrival",
    "pit_service_started",
    "fuel_service_observed",
    "repair_service_observed",
    "pit_service_completed",
    "pit_stall_departure",
    "pit_exit",
  ]);
  for (const event of pitVisit.slice(1)) {
    expect(event.linkedEventId).toBe(pitEntry!.eventId);
  }
  const sourceConnected = events.find(({ eventType }) => eventType === "source_connected");
  expect(sourceConnected).toBeDefined();
  expect(sourceConnected!.lifecycleId).not.toBeNull();
}

describe("raw race-event replay parity", () => {
  test("rebuilds stable semantic IDs and canonical order from identical frames", async () => {
    const frames = fixtureFrames();
    const input: RebuildRaceEventTimelineInput = {
      sessionId: 7_001,
      analysisGenerationId: "analysis-generation:test-replay-parity",
      gameId: "iracing",
      frames,
      sourceKind: "raceiq-raw",
      participant: LOCAL_PLAYER_EVIDENCE,
      versionIdentity: VERSION_IDENTITY,
      sourceVerification: SOURCE_VERIFICATION,
      canonicalVerification: CANONICAL_VERIFICATION,
    };

    const first = await rebuildRaceEventTimeline(input);
    const second = await rebuildRaceEventTimeline(input);

    expect(first.events.length).toBeGreaterThan(0);
    expect(second.events.map(({ eventId }) => eventId)).toEqual(
      first.events.map(({ eventId }) => eventId),
    );
    expect(second.events.map(({ contentHash }) => contentHash)).toEqual(
      first.events.map(({ contentHash }) => contentHash),
    );
    expect(first.events.every(({ sourceGeneration }) => sourceGeneration === CANONICAL_VERIFICATION.sourceGeneration)).toBe(true);
    expect(first.events.every(({ analysisGenerationId }) => analysisGenerationId === input.analysisGenerationId)).toBe(true);
    expect(second.laps.map(({ lapNumber }) => lapNumber)).toEqual(
      first.laps.map(({ lapNumber }) => lapNumber),
    );
    expect(first.runs.length).toBeGreaterThan(0);
    expect(first.runs.every(({ analysisGenerationId }) => analysisGenerationId === input.analysisGenerationId)).toBe(true);
    expect(first.memberships.every(({ runId }) => first.runs.some((run) => run.runId === runId))).toBe(true);
    expect(second.runs).toEqual(first.runs);
    expect(second.memberships).toEqual(first.memberships);
    expect(second.evidence).toEqual(first.evidence);
  });

  test("does not fabricate a terminal session event from raw replay EOF", async () => {
    const rebuilt = await rebuildRaceEventTimeline({
      sessionId: 7_002,
      analysisGenerationId: "analysis-generation:replay-eof",
      gameId: "iracing",
      frames: fixtureFrames(),
      sourceKind: "raceiq-raw",
      participant: LOCAL_PLAYER_EVIDENCE,
      versionIdentity: VERSION_IDENTITY,
      sourceVerification: SOURCE_VERIFICATION,
      canonicalVerification: CANONICAL_VERIFICATION,
    });

    expect(rebuilt.events.some(({ eventType }) => eventType === "session_ended")).toBe(false);
  });

  test(
    "keeps live, import, raw, and raw-removed canonical replay artifacts aligned",
    async () => {
      const frames = fixtureFrames();
      const createdSessionIds = new Set<number>();
      const canonicalSessionDirs = new Set<string>();
      try {
        const live = await runLivePath(frames);
        createdSessionIds.add(live.sessionId);
        const imported = await runImportPath(frames);
        createdSessionIds.add(imported.sessionId);
        const rebuiltLive = await rebuildForSession(live.sessionId, frames);
        const rebuiltImport = await rebuildForSession(imported.sessionId, frames);
        const liveInitial = await persistedSessionParity(live.sessionId);
        const importInitial = await persistedSessionParity(imported.sessionId);

        const liveEvents = sessionBoundEvents(live.events);
        const importEvents = sessionBoundEvents(imported.events);
        const rawLiveEvents = sessionBoundEvents(rebuiltLive);
        const rawImportEvents = sessionBoundEvents(rebuiltImport);

        expect(liveEvents.map(normalizedEvent)).toEqual(rawLiveEvents.map(normalizedEvent));
        expect(importEvents.map(normalizedEvent)).toEqual(rawImportEvents.map(normalizedEvent));
        expect(orderedCrossSessionEvents(importEvents)).toEqual(orderedCrossSessionEvents(liveEvents));
        expect(orderedCrossSessionEvents(importInitial.events)).toEqual(orderedCrossSessionEvents(liveInitial.events));
        assertFixtureLandmarks(liveEvents);
        assertFixtureLandmarks(importEvents);
        assertFixtureLandmarks(rawLiveEvents);
        await reprocessSession(imported.sessionId);
        const rawRebuilt = await persistedSessionParity(imported.sessionId);


        const rawCapture = await db
          .select({ rawFile: sessions.rawFile })
          .from(sessions)
          .where(eq(sessions.id, imported.sessionId))
          .get();
        if (!rawCapture?.rawFile) throw new Error("Imported parity session has no raw capture");
        const sourceIdentity = await loadRawCaptureIdentity(rawCapture.rawFile);
        if (!sourceIdentity) throw new Error("Imported parity raw capture is unreadable");
        const job = await enqueueCanonicalArchiveJob({
          sessionId: imported.sessionId,
          sourceContentHash: sourceIdentity.contentHash,
        });
        const claim = await claimCanonicalArchiveJob({ jobId: job.jobId, leaseMs: 60_000 });
        if (claim?.jobId !== job.jobId || !claim.leaseToken) throw new Error("Canonical parity job claim failed");
        const canonical = await buildCanonicalArchive({
          sessionId: imported.sessionId,
          sourceContentHash: sourceIdentity.contentHash,
          jobId: claim.jobId,
          leaseToken: claim.leaseToken,
        });
        canonicalSessionDirs.add(dirname(dirname(canonical.archive.archivePath)));
        const canonicalSourceGeneration = canonical.archive.outputContentHash;
        if (!canonicalSourceGeneration) throw new Error("Canonical parity archive has no output identity");

        unlinkSync(rawCapture.rawFile);
        expect(existsSync(rawCapture.rawFile)).toBe(false);
        await reprocessSession(imported.sessionId);
        const canonicalAfter = await persistedSessionParity(imported.sessionId);

        expect(canonicalAfter.events.map(normalizedEvent)).toEqual(rawRebuilt.events.map(normalizedEvent));
        expect(canonicalAfter.laps).toEqual(rawRebuilt.laps);
        expect(canonicalAfter.runs).toEqual(rawRebuilt.runs);
        expect(canonicalAfter.memberships).toEqual(rawRebuilt.memberships);
        expect(canonicalAfter.evidence).toEqual(rawRebuilt.evidence);
        expect(canonicalAfter.result).toEqual(rawRebuilt.result);
        expect(canonicalAfter.quality).toEqual(rawRebuilt.quality);
        expect(canonicalAfter.stableIds).toEqual(rawRebuilt.stableIds);
        expect(importInitial.sourceGenerations.events).toHaveLength(1);
        const importSourceGeneration = importInitial.sourceGenerations.events[0];
        if (!importSourceGeneration) throw new Error("Imported parity events have no source generation");
        expect(importInitial.sourceGenerations.runs).toEqual([importSourceGeneration]);
        expect(importInitial.sourceGenerations.quality).not.toBeNull();
        expect(canonicalAfter.sourceGenerations.runs).toEqual([canonicalSourceGeneration]);
        expect(canonicalAfter.sourceGenerations.events).toContain(canonicalSourceGeneration);
        expect(canonicalAfter.sourceGenerations.archiveQuality).toBe(canonical.archive.sourceContentHash);
        expect(canonicalAfter.sourceGenerations.canonicalQuality).toBe(canonicalSourceGeneration);
        expect(canonicalAfter.sourceGenerations.quality).not.toBeNull();
        expect(canonicalAfter.sourceGenerations.quality).not.toBe(rawRebuilt.sourceGenerations.quality);
        expect(canonicalAfter.eligibilityGenerations).toHaveLength(rawRebuilt.eligibilityGenerations.length);
        for (const generation of canonicalAfter.eligibilityGenerations) {
          expect(generation.sourceGeneration).toBe(canonical.archive.sourceContentHash);
          expect(generation.outputGeneration).toBe(generation.qualityOutputGeneration);
        }
      } finally {
        for (const sessionId of createdSessionIds) {
          await deleteSession(sessionId);
        }
        for (const directory of canonicalSessionDirs) {
          rmSync(directory, { force: true, recursive: true });
        }
      }
    },
    { timeout: 120_000 },
  );

  test("rolls back a partial replay longer than ten seconds when complete laps are required", async () => {
    const game = getServerGame("iracing");
    const parserState = game.createParserState?.() ?? null;
    const partial: Buffer[] = [];
    let startTimestamp: number | null = null;
    for (const { frame } of fixtureFrames()) {
      const telemetry = game.tryParse(frame, parserState);
      if (!telemetry) continue;
      startTimestamp ??= telemetry.TimestampMS;
      partial.push(frame);
      if (telemetry.TimestampMS - startTimestamp > 10_000) break;
    }

    const before = await durableImportArtifacts();
    const rawFilesBefore = rawImportFiles();
    await expect(
      importSessionFrames(partial, "iracing", {
        requireLaps: true,
        sourceKind: "raceiq-raw",
        participant: LOCAL_PLAYER_EVIDENCE,
        versionIdentity: VERSION_IDENTITY,
        sourceArchiveVerification: SOURCE_VERIFICATION,
      }),
    ).rejects.toBeInstanceOf(IncompleteImportError);
    expect(await durableImportArtifacts()).toEqual(before);
    expect(rawImportFiles()).toEqual(rawFilesBefore);
  });
});
