import { describe, expect, test } from "bun:test";
import type { Corner } from "../../../server/lap-analysis/corners"
import { telemetryToSymptoms } from "../../../server/ai/tune-symptoms";
import type { TelemetryPacket } from "../../../shared/telemetry/types";

/** Minimal packet with a distance and optional per-corner slip overrides. */
function packet(distance: number, o: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    DistanceTraveled: distance,
    Speed: 100,
    Brake: 0,
    TireSlipRatioFL: 0, TireSlipRatioFR: 0, TireSlipRatioRL: 0, TireSlipRatioRR: 0,
    TireSlipAngleFL: 0, TireSlipAngleFR: 0, TireSlipAngleRL: 0, TireSlipAngleRR: 0,
    NormSuspensionTravelFL: 0, NormSuspensionTravelFR: 0, NormSuspensionTravelRL: 0, NormSuspensionTravelRR: 0,
    TireTempFL: 0, TireTempFR: 0, TireTempRL: 0, TireTempRR: 0,
    ...o,
  } as TelemetryPacket;
}

describe("telemetryToSymptoms — relative corner distance", () => {
  // Corner bounds from detectCorners are relative to lap start. A lap whose
  // DistanceTraveled starts well above zero (cumulative odometer — ACC, Forza)
  // must still match frames and place the corner along the lap. Under the old
  // absolute-distance filter this produced zero corner symptoms.
  test("matches frames and places corners when the lap doesn't start at 0", () => {
    const START = 1000; // lap begins at a large cumulative distance
    const packets: TelemetryPacket[] = [];
    for (let rel = 0; rel <= 300; rel += 5) {
      // Understeer (front slips more than rear) through the relative 100-200 window.
      const cornering = rel >= 100 && rel <= 200;
      packets.push(
        packet(START + rel, {
          TireSlipAngleFL: cornering ? 0.12 : 0,
          TireSlipAngleFR: cornering ? 0.12 : 0,
          TireSlipAngleRL: 0,
          TireSlipAngleRR: 0,
        }),
      );
    }

    const corners: Corner[] = [{ index: 1, label: "T1", distanceStart: 100, distanceEnd: 200 }];
    const sym = telemetryToSymptoms(packets, corners);

    // Corner matched (would be empty under the absolute-distance bug).
    expect(sym.corners.length).toBe(1);
    expect(sym.aggregate.understeerCorners).toContain("T1");

    // Placed at its mid-point fraction: rel mid 150 over a 300 span → 0.5.
    expect(sym.corners[0].distanceFrac).toBeCloseTo(0.5, 2);
  });

  test("distanceFrac stays within 0-1", () => {
    const packets: TelemetryPacket[] = [];
    for (let rel = 0; rel <= 300; rel += 5) packets.push(packet(500 + rel, { TireSlipAngleFL: 0.1, TireSlipAngleFR: 0.1 }));
    const corners: Corner[] = [
      { index: 1, label: "T1", distanceStart: 0, distanceEnd: 40 },
      { index: 2, label: "T2", distanceStart: 260, distanceEnd: 300 },
    ];
    const sym = telemetryToSymptoms(packets, corners);
    for (const c of sym.corners) {
      expect(c.distanceFrac).toBeGreaterThanOrEqual(0);
      expect(c.distanceFrac).toBeLessThanOrEqual(1);
    }
  });
});
