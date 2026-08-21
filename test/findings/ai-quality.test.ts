import { describe, expect, test } from "bun:test";

import { buildAnalystPrompt } from "../../server/ai/analyst-prompt";
import { buildChatSystemPrompt } from "../../server/ai/chat-prompt";
import { buildCompareInsightsBlock } from "../../server/ai/insight-format";
import { initServerGameAdapters } from "../../server/games/init";
import { initGameAdapters } from "../../shared/games/init";
import type { TelemetryPacket } from "../../shared/telemetry/types";

initGameAdapters();
initServerGameAdapters();

function packet(index: number, count: number): TelemetryPacket {
  const progress = count <= 1 ? 0 : index / (count - 1);
  return {
    gameId: "fm-2023",
    CarOrdinal: 0,
    TrackOrdinal: 0,
    CarClass: 0,
    CarPerformanceIndex: 0,
    DrivetrainType: 0,
    VelocityX: 20,
    VelocityY: 0,
    VelocityZ: 0,
    CurrentEngineRpm: 6000,
    Accel: 128,
    Brake: 0,
    TireTempFL: 80,
    TireTempFR: 80,
    TireTempRL: 80,
    TireTempRR: 80,
    TireWearFL: 0.1,
    TireWearFR: 0.1,
    TireWearRL: 0.1,
    TireWearRR: 0.1,
    SuspensionTravelMFL: 0.1,
    SuspensionTravelMFR: 0.1,
    SuspensionTravelMRL: 0.1,
    SuspensionTravelMRR: 0.1,
    Gear: 3,
    DistanceTraveled: progress * 1000,
    CurrentLap: progress * 90,
    TimestampMS: progress * 90_000,
    PositionX: 0,
    PositionZ: 0,
  } as TelemetryPacket;
}

const lap = {
  id: 41,
  sessionId: 7,
  lapNumber: 2,
  lapTime: 90,
  isValid: true,
  gameId: "fm-2023" as const,
};

describe("AI lap quality context", () => {
  test("analyst, lap chat, and compare context abstain for rejected telemetry", () => {
    const rejectedPackets = [packet(0, 1)];

    const analystPrompt = buildAnalystPrompt(lap, rejectedPackets, []);
    const chatPrompt = buildChatSystemPrompt(lap, rejectedPackets, []);
    const compareContext = buildCompareInsightsBlock("Lap A", rejectedPackets, lap.gameId, {
      sessionId: lap.sessionId,
      lapId: lap.id,
      lapTime: lap.lapTime,
    });

    for (const context of [analystPrompt, chatPrompt, compareContext]) {
      expect(context).toContain("[ABSTENTION]");
      expect(context).toContain("too few telemetry packets");
      expect(context).toContain("do not make lap-performance claims");
    }
  });

  test("valid telemetry keeps AI context available without quality abstention", () => {
    const validPackets = Array.from({ length: 30 }, (_, index) => packet(index, 30));

    expect(buildAnalystPrompt(lap, validPackets, [])).not.toContain("Lap recording quality rejected");
    expect(buildChatSystemPrompt(lap, validPackets, [])).not.toContain("Lap recording quality rejected");
    expect(buildCompareInsightsBlock("Lap A", validPackets, lap.gameId, {
      sessionId: lap.sessionId,
      lapId: lap.id,
      lapTime: lap.lapTime,
    })).not.toContain("recording quality rejected");
  });
});
