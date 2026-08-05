import { describe, expect, test } from "bun:test";
import { resolveCarName } from "../../../shared/racing/cars/resolve-name";
import { resolveTrackName } from "../../../shared/racing/tracks/resolve-name";
import { initGameAdapters } from "../../../shared/games/init";
import { initServerGameAdapters } from "../../../server/games/init";
import { buildChatSystemPrompt, formatLapChatIdentity } from "../../../server/ai/chat-prompt";

initGameAdapters();
initServerGameAdapters();

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

  test("keeps chat prose instructions separate from analyst JSON instructions", () => {
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
    expect(prompt).toContain("Lap ID: 5");
    expect(prompt).toContain("No JSON output.");
    expect(prompt).toContain("--- TELEMETRY DATA ---");
    expect(prompt).not.toContain("Your response MUST be valid JSON");
  });

  test("identifies game and car in session identity", () => {
    const prompt = buildChatSystemPrompt({
      id: 5,
      lapNumber: 2,
      lapTime: 79.328,
      isValid: true,
      carOrdinal: 1,
      trackOrdinal: 19,
      gameId: "f1-2025",
    }, [{
      gameId: "f1-2025",
      CarOrdinal: 1,
      DistanceTraveled: 0,
      VelocityX: 0,
      VelocityY: 0,
      VelocityZ: 0,
      CurrentEngineRpm: 0,
      Accel: 0,
      Brake: 0,
      TireTempFL: 0,
      TireTempFR: 0,
      TireTempRL: 0,
      TireTempRR: 0,
      TireWearFL: 0,
      TireWearFR: 0,
      TireWearRL: 0,
      TireWearRR: 0,
      Gear: 1,
    } as never], []);

    expect(prompt).toContain("Game: F1 2025");
    expect(prompt).toContain("Game ID: f1-2025");
    expect(prompt).toContain(`Car: ${resolveCarName(1, "f1-2025")}`);
    expect(prompt).toContain("Car ID: 1");
    expect(prompt).toContain("Track ID: 19");
    expect(prompt).toContain(`Track: ${resolveTrackName(19, "f1-2025")}`);
  });

});
