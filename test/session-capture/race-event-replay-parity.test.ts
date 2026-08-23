import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { initGameAdapters } from "../../shared/games/init";
import { type RaceEvent, type RaceEventType } from "../../shared/racing/events/contracts";
import { LOCAL_PLAYER_EVIDENCE } from "../../shared/racing/quality/contracts";
import { deleteSession } from "../../server/db/session-queries";
import { listSessionRaceEvents } from "../../server/db/race-event-queries";
import { initServerGameAdapters } from "../../server/games/init";
import { getServerGame } from "../../server/games/registry";
import { readIRacingFrames } from "../../server/games/iracing/recorder";
import { rebuildRaceEventTimeline, type RebuildRaceEventTimelineInput } from "../../server/race-events/rebuild";
import { DatabaseRaceEventStore } from "../../server/race-events/store";
import { ImportCaptureAdapter, IncompleteImportError, importSessionFrames } from "../../server/session-capture/import-pipeline";
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { currentTelemetryVersionIdentity, NullSessionRecorderAdapter, NullWsAdapter, RealDbAdapter } from "../../server/telemetry/pipeline-ports";

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
  sourceGeneration: `sha256:${"a".repeat(64)}`,
};
const CANONICAL_VERIFICATION = {
  state: "verified" as const,
  sourceGeneration: `sha256:${"b".repeat(64)}`,
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
    expect(second.events.map(({ eventId }) => eventId)).toEqual(first.events.map(({ eventId }) => eventId));
    expect(second.events.map(({ contentHash }) => contentHash)).toEqual(first.events.map(({ contentHash }) => contentHash));
    expect(second.laps.map(({ lapNumber }) => lapNumber)).toEqual(first.laps.map(({ lapNumber }) => lapNumber));
  });

  test("does not fabricate a terminal session event from raw replay EOF", async () => {
    const rebuilt = await rebuildRaceEventTimeline({
      sessionId: 7_002,
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
    "keeps live, import, and raw replay semantics aligned for one fixed session",
    async () => {
      const frames = fixtureFrames();
      const createdSessionIds = new Set<number>();
      try {
        const live = await runLivePath(frames);
        createdSessionIds.add(live.sessionId);
        const imported = await runImportPath(frames);
        createdSessionIds.add(imported.sessionId);
        const rebuiltLive = await rebuildForSession(live.sessionId, frames);
        const rebuiltImport = await rebuildForSession(imported.sessionId, frames);

        const liveEvents = sessionBoundEvents(live.events);
        const importEvents = sessionBoundEvents(imported.events);
        const rawLiveEvents = sessionBoundEvents(rebuiltLive);
        const rawImportEvents = sessionBoundEvents(rebuiltImport);

        expect(liveEvents.map(normalizedEvent)).toEqual(rawLiveEvents.map(normalizedEvent));
        expect(importEvents.map(normalizedEvent)).toEqual(rawImportEvents.map(normalizedEvent));
        expect(orderedCrossSessionEvents(importEvents)).toEqual(orderedCrossSessionEvents(liveEvents));
        assertFixtureLandmarks(liveEvents);
        assertFixtureLandmarks(importEvents);
        assertFixtureLandmarks(rawLiveEvents);
      } finally {
        for (const sessionId of createdSessionIds) {
          await deleteSession(sessionId);
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

    await expect(
      importSessionFrames(partial, "iracing", {
        requireLaps: true,
        sourceKind: "raceiq-raw",
        participant: LOCAL_PLAYER_EVIDENCE,
        versionIdentity: VERSION_IDENTITY,
        sourceArchiveVerification: SOURCE_VERIFICATION,
      }),
    ).rejects.toBeInstanceOf(IncompleteImportError);
  });
});
