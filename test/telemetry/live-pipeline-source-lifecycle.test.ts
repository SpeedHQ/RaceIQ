import { afterAll, describe, expect, test } from "bun:test";
import { initGameAdapters } from "../../shared/games/init";
import type { GameId } from "../../shared/games/ids";
import type { LapMeta } from "../../shared/racing/sessions/types";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  LOCAL_PLAYER_EVIDENCE,
  type ArchiveVerification,
  type LapQualitySummary,
  type ParticipantEvidence,
  type RecordingQualitySummary,
} from "../../shared/racing/quality/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { initServerGameAdapters } from "../../server/games/init";
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { CapturingDbAdapter, CapturingWsAdapter, NullSessionRecorderAdapter, NullWsAdapter, type SessionRecorderAdapter } from "../../server/telemetry/pipeline-ports";

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

function telemetryPacket(gameId: GameId, timestampMs: number): TelemetryPacket {
  return {
    gameId,
    IsRaceOn: 1,
    TimestampMS: timestampMs,
    LapNumber: 1,
    CurrentLap: timestampMs / 1000,
    LastLap: 0,
    BestLap: 0,
    CurrentRaceTime: timestampMs / 1000,
    DistanceTraveled: timestampMs / 10,
    CarOrdinal: 100,
    TrackOrdinal: 5,
    CarPerformanceIndex: 0,
    CarClass: 0,
    RacePosition: 1,
    Speed: 50,
    PositionX: timestampMs / 100,
    PositionY: 0,
    PositionZ: timestampMs / 50,
    Fuel: 50,
    TireWearFL: 1,
    TireWearFR: 1,
    TireWearRL: 1,
    TireWearRR: 1,
  } as TelemetryPacket;
}

class CapturingSessionRecorder implements SessionRecorderAdapter {
  readonly sessions: Array<{ gameId: GameId; records: Buffer[] }> = [];
  private current: { gameId: GameId; records: Buffer[] } | null = null;
  private currentEpoch = 0;

  get active(): boolean {
    return this.current !== null;
  }
  get path(): string | null {
    return null;
  }
  get epoch(): number {
    return this.currentEpoch;
  }
  start(gameId: GameId): void {
    this.current = { gameId, records: [] };
    this.sessions.push(this.current);
    this.currentEpoch++;
  }
  writeMetaFrame(): void {}
  writeRecord(buf: Buffer): void {
    this.current?.records.push(buf);
  }
  getCurrentByteOffset(): number {
    return this.current?.records.reduce((total, record) => total + record.length + 4, 0) ?? 0;
  }
  flush(): void {}
  stop(): Promise<ArchiveVerification> {
    this.current = null;
    return Promise.resolve({ state: "verified", sourceGeneration: "sha256:test" });
  }
}

class DelayedQualityDb extends CapturingDbAdapter {
  private releaseQualityUpdate!: () => void;
  private markQualityUpdateStarted!: () => void;
  private readonly qualityUpdateGate = new Promise<void>((resolve) => {
    this.releaseQualityUpdate = resolve;
  });
  readonly qualityUpdateStarted = new Promise<void>((resolve) => {
    this.markQualityUpdateStarted = resolve;
  });

  release(): void {
    this.releaseQualityUpdate();
  }

  override async updateSessionQuality(sessionId: number, quality: RecordingQualitySummary): Promise<RecordingQualitySummary> {
    this.markQualityUpdateStarted();
    await this.qualityUpdateGate;
    return super.updateSessionQuality(sessionId, quality);
  }
}

const PROVISIONAL_LAP_GENERATION = "provisional:live-lap";
const FINALIZED_LAP_GENERATION = "sha256:finalized-live-lap";

class FinalizingSnapshotDb extends CapturingDbAdapter {
  snapshotProvider: () => readonly LapMeta[] = () => [];
  private finalizedLaps: LapMeta[] = [];

  constructor(private readonly provisionalLaps: LapMeta[]) {
    super();
  }

  override async updateSessionQuality(sessionId: number, quality: RecordingQualitySummary): Promise<RecordingQualitySummary> {
    const finalized = await super.updateSessionQuality(sessionId, quality);
    this.finalizedLaps = this.snapshotProvider().map((lap) => ({
      ...lap,
      quality: {
        ...lap.quality!,
        provenance: {
          ...lap.quality!.provenance,
          outputGeneration: FINALIZED_LAP_GENERATION,
        },
      },
      qualityGeneration: FINALIZED_LAP_GENERATION,
      qualityStale: false,
    }));
    return finalized;
  }

  override getLaps(): Promise<LapMeta[]> {
    return Promise.resolve(this.finalizedLaps.length > 0 ? this.finalizedLaps : this.provisionalLaps);
  }
}

async function captureParticipant(participant?: ParticipantEvidence) {
  const db = new CapturingDbAdapter();
  const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), {
    bypassPacketRateFilter: true,
    skipHistorySeeding: true,
    skipDevState: true,
    recorder: new NullSessionRecorderAdapter(),
    ...(participant ? { participant } : {}),
  });

  await pipeline.processPacket({
    ...telemetryPacket("fm-2023", 1_000),
    CurrentLap: 30,
    DistanceTraveled: 2_000,
  });
  await pipeline.processPacket({
    ...telemetryPacket("fm-2023", 2_000),
    LapNumber: 2,
    CurrentLap: 0.1,
    LastLap: 90,
    DistanceTraveled: 5_000,
  });
  await pipeline.finalizeCurrentSession();

  return {
    sessionQuality: db.sessionQuality.get(1),
    lapQuality: db.laps[0]?.quality,
  };
}

describe("LiveTelemetryPipeline source lifecycle scoping", () => {
  afterAll(() => {
    stopMaintenanceTasks();
  });
  test("preserves participant evidence across recording and emitted laps", async () => {
    const participant: ParticipantEvidence = {
      kind: "opponent",
      sourceId: "car-17",
      stableId: "driver-17",
      identityState: "stable",
    };

    const explicit = await captureParticipant(participant);
    expect(explicit.sessionQuality?.participant).toEqual(participant);
    expect(explicit.lapQuality?.participant).toEqual(participant);

    const defaulted = await captureParticipant();
    expect(defaulted.sessionQuality?.participant).toEqual(LOCAL_PLAYER_EVIDENCE);
    expect(defaulted.lapQuality?.participant).toEqual(LOCAL_PLAYER_EVIDENCE);
  });
  test("drops stale UDP timeout evidence while ACC session is active", async () => {
    const db = new CapturingDbAdapter();
    const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
    });

    await pipeline.processPacket(telemetryPacket("acc", 1_000));
    await pipeline.noteSourceLifecycle(
      {
        kind: "timeout",
        timestampMs: Date.now(),
        eventId: "udp-timeout:stale",
      },
      { kind: "udp", gameId: "fm-2023", sessionId: 1 },
    );
    await pipeline.finalizeCurrentSession();

    const quality = db.sessionQuality.get(1);
    expect(quality).toBeDefined();
    expect(quality?.facts.some(({ details }) => details?.lifecycleEvent === "timeout")).toBe(false);
    expect(quality?.facts.some(({ eventIds }) => eventIds.includes("udp-timeout:stale"))).toBe(false);
  });

  test("records lifecycle evidence for matching UDP session identity", async () => {
    const db = new CapturingDbAdapter();
    const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
    });

    await pipeline.processPacket(telemetryPacket("fm-2023", 1_000));
    await pipeline.noteSourceLifecycle(
      {
        kind: "reconnect",
        timestampMs: Date.now(),
        eventId: "udp-reconnect:accepted",
      },
      { kind: "udp", gameId: "fm-2023", sessionId: 1 },
    );
    await pipeline.finalizeCurrentSession();

    expect(db.sessionQuality.get(1)?.facts.find(({ code }) => code === "source_reconnect")?.eventIds).toEqual(["udp-reconnect:accepted"]);
  });

  test("refreshes in-memory lap snapshots after session quality finalization", async () => {
    const db = new FinalizingSnapshotDb([
      {
        id: 1,
        sessionId: 1,
        lapNumber: 1,
        lapTime: 90,
        isValid: true,
        phase: "flying",
        conditions: [],
        paceEligibility: "eligible",
        createdAt: new Date(0).toISOString(),
        gameId: "fm-2023",
        carOrdinal: 100,
        trackOrdinal: 5,
        source: "native-live",
        quality: {
          provenance: {
            schemaVersion: QUALITY_SCHEMA_VERSION,
            policyVersion: ELIGIBILITY_POLICY_VERSION,
            configurationVersion: QUALITY_CONFIG_VERSION,
            sourceGeneration: PROVISIONAL_LAP_GENERATION,
            outputGeneration: PROVISIONAL_LAP_GENERATION,
          },
        } as unknown as LapQualitySummary,
        qualityGeneration: PROVISIONAL_LAP_GENERATION,
        qualityStale: true,
      },
    ]);
    const ws = new CapturingWsAdapter();
    const pipeline = new LiveTelemetryPipeline(db, ws, {
      bypassPacketRateFilter: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
    });
    db.snapshotProvider = () => pipeline.sessionLaps;

    await pipeline.processPacket(telemetryPacket("fm-2023", 1_000));
    await pipeline.finalizeCurrentSession();

    expect(pipeline.sessionLaps).toHaveLength(1);
    expect(pipeline.sessionLaps[0]?.qualityGeneration).toBe(FINALIZED_LAP_GENERATION);
    expect(pipeline.sessionLaps[0]?.quality?.provenance.outputGeneration).toBe(FINALIZED_LAP_GENERATION);
    expect(ws.broadcastedNotifications).toContainEqual({
      type: "session-laps",
      laps: [expect.objectContaining({ qualityGeneration: FINALIZED_LAP_GENERATION })],
    });
  });

  test("starts the rotated recorder before old-session quality persistence completes", async () => {
    const db = new DelayedQualityDb();
    const recorder = new CapturingSessionRecorder();
    const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder,
    });
    const firstFrame = Buffer.from("first-session");
    const rotationFrame = Buffer.from("rotation");
    const concurrentFrame = Buffer.from("during-finalization");

    await pipeline.processPacket(telemetryPacket("acc", 1_000), firstFrame);
    const rotation = pipeline.processPacket(telemetryPacket("ac-evo", 1_100), rotationFrame);
    await db.qualityUpdateStarted;

    const activeDuringFinalization = recorder.active;
    const concurrentPacket = pipeline.processPacket(telemetryPacket("ac-evo", 1_200), concurrentFrame);
    await Promise.all([rotation, concurrentPacket]);
    const recordsBeforeRelease = recorder.sessions[1]?.records.map((record) => record.toString()) ?? [];

    expect(activeDuringFinalization).toBe(true);
    expect(recordsBeforeRelease).toContain("during-finalization");

    db.release();
    await pipeline.finalizeCurrentSession();
  });
});
