import { describe, expect, test } from "bun:test";
import { compressTelemetry, decompressTelemetry } from "../../server/db/telemetry-codec";
import type { TelemetryPacket } from "../../shared/telemetry/types";

describe("detailed telemetry storage", () => {
  test("round-trips detailed tire temperatures without turning absent fields into zero", () => {
    const packet = {
      gameId: "iracing",
      TireTempFL: 84,
      TireCarcassTempFL: 84,
      TireCarcassTempLeftFL: 82,
      TireCarcassTempMiddleFL: 84,
      TireCarcassTempRightFL: 86,
    } as TelemetryPacket;

    const [restored] = decompressTelemetry(compressTelemetry([packet]));

    expect(restored.gameId).toBe("iracing");
    expect(restored.TireTempFL).toBe(84);
    expect(restored.TireCarcassTempFL).toBe(84);
    expect(restored.TireCarcassTempLeftFL).toBe(82);
    expect(restored.TireCarcassTempMiddleFL).toBe(84);
    expect(restored.TireCarcassTempRightFL).toBe(86);
    expect(restored.TireSurfaceTempInnerFL).toBeUndefined();
    expect(restored.BrakeTempFrontLeft).toBeUndefined();
  });
  test("optionally preserves opponent grid metadata for engineer replay", () => {
    const grid = [{ position: 1, driverId: 7, driverName: "Driver 7", completedLapNumber: 3 }];
    const packet = { gameId: "f1-2025", f1: { grid } } as unknown as TelemetryPacket;

    const omitted = decompressTelemetry(compressTelemetry([packet], { storeOpponentGrid: false }))[0];
    expect(omitted.f1?.grid).toBeUndefined();

    const stored = decompressTelemetry(compressTelemetry([packet], { storeOpponentGrid: true }))[0];
    expect(JSON.stringify(stored.f1?.grid)).toBe(JSON.stringify(grid));
  });
});
