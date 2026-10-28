import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { describe, expect, test } from "bun:test";
import type { Corner } from "@raceiq/backend-core/lap-analysis/corners"
import { formatTireTempSymptoms, tireTempSymptoms } from "@raceiq/backend-core/ai/tune-tire-symptoms";
import { telemetryToSymptoms } from "@raceiq/backend-core/ai/tune-symptoms";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { formatTireTempGuide } from "@raceiq/backend-core/ai/tire-temp-guide";
import { getTireTempGuide } from "@raceiq/shared/racing/live/tire-thresholds";
import { buildKunosAiContext } from "@raceiq/backend-core/games/kunos/ai-context";

initGameAdapters();

/** Minimal packet with a distance and optional per-corner slip overrides. */
function packet(distance: number, o: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId: "fm-2023",
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

describe("tireTempSymptoms", () => {
  test("uses measured core temperatures without interpreting placeholder surface bands", () => {
    const packets = Array.from({ length: 30 }, (_, index) =>
      packet(index, {
        gameId: "acc",
        acc: {
          tireCoreTemp: [80, 82, 78, 79],
          tireInnerTemp: [140, 140, 20, 20],
          tireMiddleTemp: [160, 160, 10, 10],
          tireOuterTemp: [20, 20, 140, 140],
        } as TelemetryPacket["acc"],
      })
    );

    const output = formatTireTempSymptoms(tireTempSymptoms(packets));

    expect(output).toContain("Tyre core temps");
    expect(output).toContain("FL — core 80°C");
    expect(output).not.toContain("camber");
    expect(output).not.toContain("pressure");
  });

  test("classifies against the fitted compound's optimal window", () => {
    const packetsFor = (compound: string, core: number) => Array.from({ length: 30 }, (_, index) =>
      packet(index, {
        gameId: "acc",
        acc: { tireCompound: compound, tireCoreTemp: [core, core, core, core] } as TelemetryPacket["acc"],
      })
    );
    expect(tireTempSymptoms(packetsFor("dry_compound", 60))!.corners[0]!.thermal).toBe("cold");
    expect(tireTempSymptoms(packetsFor("wet_compound", 60))!.corners[0]!.thermal).toBe("optimal");
    expect(tireTempSymptoms(packetsFor("wet_compound", 80))!.corners[0]!.thermal).toBe("hot");
  });
});

describe("tire temperature guide facts", () => {
  test("publishes per-compound windows and formats them for prompts", () => {
    expect(getTireTempGuide("acc")).toEqual({
      channel: "carcass",
      rows: [
        { compound: "dry_compound", min: 70, max: 100 },
        { compound: "wet_compound", min: 50, max: 70 },
      ],
    });
    expect(getTireTempGuide("f1-2025")!.rows.map((entry) => entry.compound)).toEqual(["soft", "medium", "hard", "inter", "wet"]);
    expect(getTireTempGuide("lmu")).toEqual({
      channel: "surface",
      rows: [
        { compound: "soft", min: 70, max: 105 },
        { compound: "medium", min: 70, max: 105 },
        { compound: "hard", min: 70, max: 105 },
      ],
    });
    expect(getTireTempGuide("fm-2023")).toBeNull();
    const guide = formatTireTempGuide("acc");
    expect(guide).toContain("dry_compound: 70-100 °C");
    expect(guide).toContain("wet_compound: 50-70 °C");
    expect(guide).toContain("count as cold tires");
    // LMU publishes surface temps only, so the cold-lap claim must not appear.
    expect(formatTireTempGuide("lmu")).toContain("optimal tire surface temperature");
    expect(formatTireTempGuide("lmu")).not.toContain("cold tires");
    expect(formatTireTempGuide("fm-2023")).toBe("");
  });

  test("Kunos AI context includes the compound guide", () => {
    const context = buildKunosAiContext(Array.from({ length: 30 }, (_, index) => ({
      ...packet(index, { gameId: "acc" }),
      acc: {
        tireCompound: "dry_compound", tireCoreTemp: [80, 80, 80, 80], fuelPerLap: 2.5,
        tc: 1, tcCut: 1, abs: 1, engineMap: 1, brakeBias: 0.56, rainIntensity: 0, trackGripStatus: "optimal",
        brakePadWear: [0, 0, 0, 0], carDamage: { front: 0, rear: 0, left: 0, right: 0 },
      } as TelemetryPacket["acc"],
    })) as TelemetryPacket[], false);
    expect(context).toContain("optimal tire carcass temperature");
    expect(context).toContain("dry_compound: 70-100 °C");
  });
});


test("AMS2 lap symptoms omit uncalibrated suspension bottoming and damper claims", () => {
  const packets = Array.from({ length: 31 }, (_, i) => packet(i * 10, {
    gameId: "ams2", NormSuspensionTravelFL: 1, NormSuspensionTravelFR: 1,
    NormSuspensionTravelRL: 1, NormSuspensionTravelRR: 1,
  }));
  const symptoms = telemetryToSymptoms(packets, [{ index: 1, label: "T1", distanceStart: 100, distanceEnd: 200 }]);
  expect(symptoms.corners).toHaveLength(1);
  expect(symptoms.corners[0].phases.every(phase => !phase.bottoming)).toBe(true);
  expect(symptoms.aggregate.bottomingCorners).toEqual([]);
  expect(symptoms.aggregate.damper).toBeNull();
});
