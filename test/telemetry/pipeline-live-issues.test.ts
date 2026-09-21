/**
 * LiveTelemetryPipeline.processPacket only computes/broadcasts live
 * transient issues when liveIssuesEnabled is on — off costs nothing extra
 * and omits _liveIssues from the WS payload entirely (see server/runtime/websocket-manager.ts's
 * `!== undefined` check), on always includes an array (possibly empty).
 */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { LapDetectorCallbacks } from "../../server/lap-detection/types";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { CapturingDbAdapter, CapturingWsAdapter, NullSessionRecorderAdapter } from "../../server/telemetry/pipeline-ports"
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "../../server/telemetry/live-pipeline"
import { isForzaRaceOffPacket, parseForzaPacket } from "../../server/games/fm-2023/parser";
import { iterateSessionFrames } from "../../server/session-capture/framing";

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
  return { pipeline, ws, db };
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

  test("disabled engineer gate still publishes telemetry without voice or catalog diagnostics", async () => {
    const db = new CapturingDbAdapter();
    const ws = new CapturingWsAdapter();
    const notifications: unknown[] = [];
    const pipeline = new LiveTelemetryPipeline(db, ws, {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      engineerEnabled: () => false,
    });
    const broadcastNotification = ws.broadcastNotification.bind(ws);
    ws.broadcastNotification = (message) => { notifications.push(message); broadcastNotification(message); };
    await pipeline.processPacket(pkt());
    expect(ws.broadcastedPackets).toHaveLength(1);
    expect(notifications.filter((message) =>
      typeof message === "object" && message !== null && "type" in message &&
      (message.type === "live-engineer-callout" || message.type === "live-engineer-voice-line"))).toEqual([]);
  });
  test("keeps an FM lap buffered through arbitrary telemetry silence", async () => {
    const { pipeline, db } = makePipeline();
    for (let index = 0; index < 60; index++) {
      await pipeline.processPacket(pkt({
        TimestampMS: 1_000 + index * 16,
        CurrentLap: 30 + index / 60,
        DistanceTraveled: 2_000 + index * 2,
      }));
    }

    const detector = pipeline.lapDetector!;
    const clockState = detector as unknown as { lastPacketTime: number };
    clockState.lastPacketTime = Date.now() - 10 * 60_000;
    await detector.flushStaleLap?.();
    expect(db.laps).toHaveLength(0);

    await pipeline.finalizeCurrentSession();
    expect(db.laps).toHaveLength(1);
    expect(db.laps[0]).toMatchObject({
      lapNumber: 1,
      isValid: false,
      invalidReason: "incomplete",
    });
  });

  test("recognizes FM race-off packets without treating silence as race-off", () => {
    const active = Buffer.alloc(331);
    active.writeInt32LE(1, 0);
    const inactive = Buffer.alloc(331);
    inactive.writeInt32LE(0, 0);

    expect(isForzaRaceOffPacket(active)).toBe(false);
    expect(isForzaRaceOffPacket(inactive)).toBe(true);
    expect(isForzaRaceOffPacket(Buffer.alloc(100))).toBe(false);
  });

  test("keeps one FM session and replaces pit snapshot before saving final lap", async () => {
    const { pipeline, db } = makePipeline();
    const frames = iterateSessionFrames(
      gunzipSync(readFileSync("test/artifacts/sessions/fm-2023-2026-09-21T02-02-34-009Z.bin.gz")),
    );
    let active = false;

    for (const frame of frames) {
      const packet = parseForzaPacket(frame);
      if (packet) {
        active = true;
        await pipeline.processPacket(packet);
      } else if (active && isForzaRaceOffPacket(frame)) {
        active = false;
        await pipeline.snapshotIncompleteLap();
      }
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(db.sessions).toHaveLength(1);
    expect(db.laps.map((lap) => lap.lapNumber)).toEqual([0, 1, 2]);
    expect(db.laps[1]).toMatchObject({
      lapNumber: 1,
      isValid: false,
      invalidReason: "inlap",
    });
    expect(db.laps[1]!.lapTime).toBeCloseTo(98.955, 3);
    expect(db.laps[2]).toMatchObject({
      lapNumber: 2,
      isValid: false,
      invalidReason: "outlap",
    });
  }, { timeout: 30_000 });
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

describe("completed-lap recording boundary", () => {
  test("saves laps without unsolicited tuning analysis", async () => {
    const { pipeline, ws } = makePipeline();
    // Exercise the detector callback boundary with an active notification consumer.
    const detectorPort = pipeline as unknown as { _buildCallbacks(): LapDetectorCallbacks };
    const callbacks = detectorPort._buildCallbacks();
    callbacks.onLapComplete!({
      packets: completedPackets(), lapDistStart: 0, lapTime: 90, isValid: true, sectors: null,
    });
    callbacks.onLapSaved!({
      lapId: 101, lapNumber: 2, lapTime: 90, isValid: true,
      sectors: null, estimatedBestLapTime: 90,
    });
    await pipeline.flushIncompleteLap();
    expect(ws.broadcastedNotifications).toEqual([
      expect.objectContaining({ type: "lap-saved", lapId: 101, lapNumber: 2 }),
    ]);
  });
});
