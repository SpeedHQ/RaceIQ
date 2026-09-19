/**
 * LiveTelemetryPipeline.processPacket only computes/broadcasts live
 * transient issues when liveIssuesEnabled is on — off costs nothing extra
 * and omits _liveIssues from the WS payload entirely (see server/runtime/websocket-manager.ts's
 * `!== undefined` check), on always includes an array (possibly empty).
 */
import { describe, test, expect, afterAll } from "bun:test";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { LapDetectorCallbacks } from "../../server/lap-detection/types";
import { analyzeLapIssues } from "../../server/telemetry/lap-issues";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { CapturingDbAdapter, CapturingWsAdapter, NullSessionRecorderAdapter } from "../../server/telemetry/pipeline-ports"
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "../../server/telemetry/live-pipeline"

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

function pkt(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId: "fm-2023",
    IsRaceOn: 1,
    TimestampMS: 1000,
    LapNumber: 1,
    CurrentLap: 30,
    LastLap: 0,
    BestLap: 0,
    DistanceTraveled: 2000,
    CarOrdinal: 100,
    TrackOrdinal: 5,
    Speed: 50,
    PositionX: 0,
    PositionZ: 0,
    Brake: 1,
    TireSlipRatioFL: 0.3,
    TireSlipRatioFR: 0,
    TireSlipRatioRL: 0,
    TireSlipRatioRR: 0,
    ...overrides,
  } as TelemetryPacket;
}

function makePipeline(
  onSessionFinalized?: (sessionId: number, gameId: TelemetryPacket["gameId"]) => Promise<void>,
) {
  const db = new CapturingDbAdapter();
  const ws = new CapturingWsAdapter();
  const pipeline = new LiveTelemetryPipeline(db, ws, {
    bypassPacketRateFilter: true,
    skipHistorySeeding: true,
    skipDevState: true,
    recorder: new NullSessionRecorderAdapter(),
    onSessionFinalized,
  });
  return { pipeline, ws };
}

describe("LiveTelemetryPipeline live issue gating", () => {

  test("disabled: broadcast liveIssues arg is undefined", async () => {
    const { pipeline, ws } = makePipeline();
    await pipeline.processPacket(pkt());
    expect(ws.broadcastedPackets).toHaveLength(1);
    expect(ws.broadcastedPackets[0].liveIssues).toBeUndefined();
  });

  test("enabled: broadcast liveIssues is an array reflecting detected issues", async () => {
    const { pipeline, ws } = makePipeline();
    pipeline.setLiveIssuesEnabled(true);
    expect(pipeline.liveIssuesEnabled).toBe(true);
    // Braking with a locked front-left wheel — detectLiveIssues should flag it.
    await pipeline.processPacket(pkt({ Brake: 1, TireSlipRatioFL: 0.3 }));
    expect(ws.broadcastedPackets).toHaveLength(1);
    const liveIssues = ws.broadcastedPackets[0].liveIssues;
    expect(liveIssues).toBeDefined();
    expect(liveIssues!.some((i) => i.kind === "brake-lockup")).toBe(true);
  });

  test("enabled but quiescent packet: liveIssues is an empty array, not undefined", async () => {
    const { pipeline, ws } = makePipeline();
    pipeline.setLiveIssuesEnabled(true);
    await pipeline.processPacket(pkt({ Brake: 0, TireSlipRatioFL: 0, Speed: 0 }));
    expect(ws.broadcastedPackets[0].liveIssues).toEqual([]);
  });

  test("toggling back off omits liveIssues again", async () => {
    const { pipeline, ws } = makePipeline();
    pipeline.setLiveIssuesEnabled(true);
    await pipeline.processPacket(pkt());
    pipeline.setLiveIssuesEnabled(false);
    await pipeline.processPacket(pkt());
    expect(ws.broadcastedPackets[1].liveIssues).toBeUndefined();
  });

  test("finalizes one result after session detector closes", async () => {
    const finalized: Array<{ sessionId: number; gameId: string }> = [];
    const { pipeline } = makePipeline(async (sessionId, gameId) => {
      finalized.push({ sessionId, gameId });
    });
    await pipeline.processPacket(pkt());
    await pipeline.processPacket(pkt({
      LapNumber: 2,
      CurrentLap: 0.1,
      LastLap: 30,
      DistanceTraveled: 2_100,
      TimestampMS: 2_000,
    }));
    await Promise.resolve();
    await Promise.resolve();
    expect(finalized).toEqual([]);


    await Promise.all([
      pipeline.finalizeCurrentSession(),
      pipeline.finalizeCurrentSession(),
    ]);
    await pipeline.finalizeCurrentSession();

    expect(finalized).toEqual([{ sessionId: 1, gameId: "fm-2023" }]);
    expect(pipeline.lapDetector?.session).toBeNull();
  });
});

function completedPackets(): TelemetryPacket[] {
  return Array.from({ length: 180 }, (_, i) => pkt({
    gameId: "acc", TimestampMS: i * 16, CurrentLap: i / 60,
    DistanceTraveled: i * 2, Speed: i < 40 ? 50 : 20,
    VelocityX: i < 40 ? 50 : 20, VelocityY: 0, VelocityZ: 0,
    Steer: i < 40 ? 0 : 50, Brake: 1, Accel: 0,
    TireSlipAngleFL: 0.1, TireSlipAngleFR: 0.1, TireSlipAngleRL: 0, TireSlipAngleRR: 0,
    TireSlipRatioFL: 0.3, TireSlipRatioFR: 0.3, TireSlipRatioRL: 0, TireSlipRatioRR: 0,
    NormSuspensionTravelFL: 0.5, NormSuspensionTravelFR: 0.5,
    NormSuspensionTravelRL: 0.5, NormSuspensionTravelRR: 0.5,
  }));
}

describe("off-thread completed-lap issues", () => {
  test("keeps ACC steering units and returns analysis after yielding ingress", async () => {
    let yielded = false;
    const analysis = analyzeLapIssues(completedPackets());
    setImmediate(() => { yielded = true; });
    const issues = await analysis;
    expect(yielded).toBe(true);
    expect(issues.map((issue) => issue.kind)).toEqual([
      "understeer", "brake-lockup", "understeer", "brake-lockup", "understeer", "brake-lockup",
    ]);
  });

  test("bounds optional backlog without poisoning subsequent lap analysis", async () => {
    const pending = Array.from({ length: 4 }, () => analyzeLapIssues(completedPackets()));
    await expect(analyzeLapIssues(completedPackets())).rejects.toThrow("backlog");
    await Promise.all(pending);
    const issues = await analyzeLapIssues(completedPackets());
    expect(issues).toContainEqual(expect.objectContaining({ kind: "understeer" }));
  });

  test("publishes saved laps before analysis and keeps concurrent results tied to lap IDs", async () => {
    const { pipeline, ws } = makePipeline();
    // Exercise the detector's existing callback boundary without synthesizing a full race.
    const detectorPort = pipeline as unknown as { _buildCallbacks(): LapDetectorCallbacks };
    const callbacks = detectorPort._buildCallbacks();
    for (const lapNumber of [2, 3]) {
      callbacks.onLapComplete!({
        packets: completedPackets(), lapDistStart: 0, lapTime: 90, isValid: true, sectors: null,
      });
      callbacks.onLapSaved!({
        lapId: lapNumber + 100, lapNumber, lapTime: 90, isValid: true,
        sectors: null, estimatedBestLapTime: 90,
      });
    }
    expect(ws.broadcastedNotifications.map((event) => event.type)).toEqual(["lap-saved", "lap-saved"]);
    await pipeline.flushIncompleteLap();
    const issues = ws.broadcastedNotifications.filter((event) => event.type === "lap-issues");
    expect(issues.map((event) => [event.lapId, event.lapNumber])).toEqual([[102, 2], [103, 3]]);
    for (const event of issues) {
      expect(event.issues).toContainEqual(expect.objectContaining({ kind: "understeer", lapNumber: event.lapNumber }));
    }
  });

  test("does not publish delayed analysis after its active session is deleted", async () => {
    const { pipeline, ws } = makePipeline();
    await pipeline.processPacket(pkt());
    // Exercise the detector's existing callback boundary with a real active session.
    const detectorPort = pipeline as unknown as { _buildCallbacks(): LapDetectorCallbacks };
    const callbacks = detectorPort._buildCallbacks();
    callbacks.onLapComplete!({
      packets: completedPackets(), lapDistStart: 0, lapTime: 90, isValid: true, sectors: null,
    });
    callbacks.onLapSaved!({
      lapId: 101, lapNumber: 2, lapTime: 90, isValid: true, sectors: null, estimatedBestLapTime: 90,
    });
    expect(await pipeline.recoverDeletedSessions([1])).toBe(true);
    await pipeline.finalizeCurrentSession();
    expect(ws.broadcastedNotifications.some((event) => event.type === "lap-issues")).toBe(false);
    expect(ws.broadcastedNotifications).toContainEqual(expect.objectContaining({ type: "lap-saved", lapId: 101 }));
  });
});
