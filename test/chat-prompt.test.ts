import { describe, expect, test } from "bun:test";
import { buildChatSystemPrompt, formatLapChatIdentity } from "../server/ai/chat-prompt";

describe("lap chat prompt", () => {
  test("exposes database lap ID separately from display lap number", () => {
    const identity = formatLapChatIdentity({
      id: 5,
      lapNumber: 2,
      lapTime: 79.328,
    });

    expect(identity).toContain("Lap ID: 5");
    expect(identity).toContain("Lap #2 — 79.328s");
  });

  test("builds without referencing missing optional tune or game context", () => {
    const prompt = buildChatSystemPrompt({
      id: 5,
      lapNumber: 2,
      lapTime: 79.328,
      isValid: true,
      gameId: "fm-2023",
    }, [{
      gameId: "fm-2023",
      CarOrdinal: 0,
      CarClass: 0,
      CarPerformanceIndex: 0,
      DrivetrainType: 0,
      VelocityX: 0,
      VelocityY: 0,
      VelocityZ: 0,
      CurrentEngineRpm: 0,
      Accel: 0,
      Brake: 0,
      TireTempFL: 32,
      TireTempFR: 32,
      TireTempRL: 32,
      TireTempRR: 32,
      TireWearFL: 0,
      TireWearFR: 0,
      TireWearRL: 0,
      TireWearRR: 0,
      Gear: 1,
      SuspensionTravelMFL: 0,
      SuspensionTravelMFR: 0,
      SuspensionTravelMRL: 0,
      SuspensionTravelMRR: 0,
    } as never], []);
  });
});

