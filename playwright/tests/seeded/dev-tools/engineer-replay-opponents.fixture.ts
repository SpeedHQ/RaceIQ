import type { LiveEngineerReplayFrameV1, LiveEngineerSessionReplayV1 } from "../../../../shared/racing/live/engineer-replay-contracts";
import type { SessionMeta } from "../../../../shared/racing/sessions/types";

export const opponentSessions: SessionMeta[] = [91001, 91002].map((id) => ({
  id, gameId: "acc", carOrdinal: id, trackOrdinal: 1, createdAt: "2026-09-21T12:00:00.000Z", lapCount: 8, sessionType: "Race",
}));

export function opponentReplay(sessionId = 91001): LiveEngineerSessionReplayV1 {
  const positions = [12, 2, 9, 1, 11, 5, 8, 3, 10, 4, 7, 6];
  const values: LiveEngineerReplayFrameV1["values"] = {
    "identity.player-car-index": 108,
    "identity.player-car-class-id": "0",
    "motion.speed": 30,
    "race.competitor.car-index": positions.map((position) => position + 100),
    "race.competitor.driver-name": positions.map((position) => `Driver ${position}`),
    "race.competitor.car-class-id": positions.map(() => "0"),
    "race.competitor.car-class-name": positions.map(() => "GT3"),
    "race.competitor.position": positions,
    "race.competitor.laps-complete": positions.map(() => 8),
    "race.competitor.pit-status": positions.map((position) => position === 8 ? "pit_lane" : "out"),
    "race.competitor.connected": positions.map((position) => position !== 8),
    "timing.competitor.last-lap-time": positions.map(() => 91.234),
    "timing.competitor.last-lap-valid": positions.map((position) => position !== 8),
  };
  const states = Object.fromEntries(Object.keys(values).map((id) => [id, "ok" as const]));
  const freshness = Object.fromEntries(Object.keys(values).map((id) => [id, "fresh" as const]));
  const sources = [
    { state: "available", reasonCode: "ready" },
    { state: "unavailable", reasonCode: "not-connected" },
    { state: "stale", reasonCode: "source-timeout" },
    { state: "malformed", reasonCode: "malformed-datagram" },
    { state: "available", reasonCode: "ready" },
  ] as const;
  return {
    sessionId, gameId: "acc", car: {}, track: {}, executionMode: "diagnostic-all-games", clockQuality: "captured",
    sourceProfile: {
      gameId: "acc", captureKind: "acc-shared-memory", limitations: [], sourceClockCaptured: true,
      opponentSourceCapture: { source: "acc-broadcast", status: "captured", recordCount: sources.length },
      segmentCount: 1, skippedMalformedFrames: 0, nativeSessionInfo: false, retainedPrefix: false,
    },
    frames: sources.map((source, frameIndex) => ({
      frameIndex, sourceSequence: frameIndex, rawSourceTimestampMs: 1_790_000_000_000 + frameIndex * 1_000,
      rawSourceTimestampDomain: "wall-clock", timelineMs: frameIndex * 1_000, triggerContext: {}, values, states, freshness,
      opponentSource: { source: "acc-broadcast", ...source },
    })),
    laps: [], systems: [], warnings: [], sourceCounts: { packets: sources.length },
    annotations: ["segments", "full-line"].map((kind, index) => ({
      id: `voice-${kind}`, frameIndex: 0, timelineMs: 0, lapNumber: 8, position: null, stage: "voice-line",
      family: "opponent-pace", action: kind, candidateId: null, decisionId: null, priority: "normal", reason: null,
      payload: null, evidence: [], renderedText: `Test ${kind}`, segmentIds: kind === "segments" ? ["test-segment"] : [],
      ...(index === 1 ? { audioLineId: "test-line" } : {}),
    })),
  };
}
