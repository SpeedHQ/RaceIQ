/**
 * LiveTelemetryPipeline.processPacket only computes/broadcasts live
 * transient issues when liveIssuesEnabled is on — off costs nothing extra
 * and omits _liveIssues from the WS payload entirely (see server/runtime/websocket-manager.ts's
 * `!== undefined` check), on always includes an array (possibly empty).
 */
import { describe, test, expect, afterAll } from "bun:test";
import type { TelemetryPacket } from "../../shared/telemetry/types";
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
  test("liveIssuesEnabled defaults to false", () => {
    const { pipeline } = makePipeline();
    expect(pipeline.liveIssuesEnabled).toBe(false);
  });

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
    await pipeline.processPacket(pkt({ TimestampMS: 2_000, CurrentLap: 31, DistanceTraveled: 2_050 }));
    expect(ws.broadcastedPackets[1].liveIssues).toBeUndefined();
  });

  test("finalizes one result after session detector closes", async () => {
    const finalized: Array<{ sessionId: number; gameId: string }> = [];
    const { pipeline } = makePipeline(async (sessionId, gameId) => {
      finalized.push({ sessionId, gameId });
    });
    await pipeline.processPacket(pkt());

    await Promise.all([
      pipeline.finalizeCurrentSession(),
      pipeline.finalizeCurrentSession(),
    ]);
    await pipeline.finalizeCurrentSession();

    expect(finalized).toEqual([{ sessionId: 1, gameId: "fm-2023" }]);
    expect(pipeline.lapDetector?.session).toBeNull();
  });
});
