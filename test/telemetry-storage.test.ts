import { describe, expect, test } from "bun:test";
import {
  compressTelemetry,
  decompressTelemetry,
} from "../server/db/queries";
import type { TelemetryPacket } from "../shared/types";

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
});
