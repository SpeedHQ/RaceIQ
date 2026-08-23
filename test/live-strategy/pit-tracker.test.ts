import { describe, test, expect, spyOn } from "bun:test";
import type { EligibilityDecision, EligibilityDecisionSet, EligibilityPolicyId } from "../../shared/racing/quality/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { SemanticTelemetrySample } from "../../shared/telemetry/replay/contracts";
import type { LapMeta } from "../../shared/racing/sessions/types";
import * as LapReadQueries from "../../server/db/lap-read-queries";
import * as TelemetryReplay from "../../server/telemetry/replay";
import { finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";
import { PitTracker } from "../../server/live-strategy/pit-tracker";
import { forzaServerAdapter } from "../../server/games/fm-2023";
import { f1ServerAdapter } from "../../server/games/f1-2025";
import { accServerAdapter } from "../../server/games/acc";
import { qualityPackets, summarize } from "../support/lap-analysis/quality-model";

function pkt(overrides: Partial<TelemetryPacket>): TelemetryPacket {
  return {
    gameId: "fm-2023",
    IsRaceOn: 1,
    TimestampMS: 0,
    DistanceTraveled: 0,
    CurrentLap: 0,
    LastLap: 0,
    BestLap: 0,
    LapNumber: 1,
    PositionX: 0,
    PositionZ: 0,
    Speed: 50,
    Fuel: 1.0,
    TireWearFL: 0,
    TireWearFR: 0,
    TireWearRL: 0,
    TireWearRR: 0,
    ...overrides,
  } as TelemetryPacket;
}

function semanticSample(values: Record<string, unknown>, observedAtMs = 0): SemanticTelemetrySample {
  return { sequence: "1", observedAtMs, values: values as SemanticTelemetrySample["values"] };
}

function policyDecision(policyId: EligibilityPolicyId, status: EligibilityDecision["status"] = "eligible"): EligibilityDecision {
  return {
    status,
    policyId,
    policyVersion: "1",
    confidence: { level: status === "unknown" ? "unknown" : "high", score: status === "unknown" ? null : 1 },
    reasons: status === "eligible" ? [] : [{ code: "channel_unavailable", severity: "error", evidenceIds: [`test:${policyId}`], timeRange: null, distanceRange: null, semanticIds: [] }],
    evidenceIds: status === "eligible" ? [] : [`test:${policyId}`],
  };
}

function pitEligibility(overrides: Partial<Record<"normal-pace" | "fuel-burn" | "tire-analysis", EligibilityDecision>> = {}): EligibilityDecisionSet {
  return {
    "normal-pace": policyDecision("normal-pace"),
    "fuel-burn": policyDecision("fuel-burn"),
    "tire-analysis": policyDecision("tire-analysis"),
    ...overrides,
  } as EligibilityDecisionSet;
}

/** Simulate completing a lap: feed a mid-lap packet then a new-lap packet. */
function completeLap(
  tracker: PitTracker,
  lapNum: number,
  opts: {
    fuel: number;
    wearFL: number;
    wearFR: number;
    wearRL: number;
    wearRR: number;
    lapTime?: number;
    eligibility?: EligibilityDecisionSet;
  },
) {
  const lapTime = opts.lapTime ?? 90;
  // Mid-lap: set CurrentLap to the lap time (this is what lastCurrentLap captures)
  tracker.feed(
    pkt({
      LapNumber: lapNum,
      CurrentLap: lapTime,
      Fuel: opts.fuel + 0.01, // slightly more fuel than at boundary
      TireWearFL: opts.wearFL - 0.001,
      TireWearFR: opts.wearFR - 0.001,
      TireWearRL: opts.wearRL - 0.001,
      TireWearRR: opts.wearRR - 0.001,
    }),
    5000,
  );
  tracker.acceptCompletedLap(opts.eligibility ?? pitEligibility());
  // Lap boundary
  tracker.feed(
    pkt({
      LapNumber: lapNum + 1,
      CurrentLap: 0,
      Fuel: opts.fuel,
      TireWearFL: opts.wearFL,
      TireWearFR: opts.wearFR,
      TireWearRL: opts.wearRL,
      TireWearRR: opts.wearRR,
    }),
    5000,
  );
}

describe("PitTracker", () => {
  test("no estimate before first completed lap", () => {
    const tracker = new PitTracker();
    const r = tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0.05, CurrentLap: 10 }), 5000);
    expect(r.tireLapsToBad).toBeNull();
    expect(r.tireLapsToCritical).toBeNull();
    expect(r.tireWearPerLap).toBe(0);
    expect(r.fuelLapsRemaining).toBeNull();
  });

  test("fuel: rolling average of last 5 valid laps", () => {
    const tracker = new PitTracker();
    // Init
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, CurrentLap: 0 }), 5000);
    // Complete 3 laps using 0.10 fuel each
    completeLap(tracker, 1, { fuel: 0.9, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0 });
    completeLap(tracker, 2, { fuel: 0.8, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0 });
    completeLap(tracker, 3, { fuel: 0.7, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0 });

    const r = tracker.feed(pkt({ LapNumber: 4, Fuel: 0.7, CurrentLap: 5 }), 5000);
    expect(r.fuelPerLap).toBeCloseTo(0.1, 2);
    expect(r.fuelLapsRemaining).toBeCloseTo(7.0, 0);
  });

  test("policy-rejected lap does not update fuel or tire estimates", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1, CurrentLap: 0 }), 5_000);
    completeLap(tracker, 1, {
      fuel: 0.9,
      wearFL: 0.1,
      wearFR: 0.1,
      wearRL: 0.1,
      wearRR: 0.1,
      eligibility: pitEligibility({
        "fuel-burn": policyDecision("fuel-burn", "ineligible"),
        "tire-analysis": policyDecision("tire-analysis", "unknown"),
      }),
    });

    const result = tracker.feed(pkt({ LapNumber: 2, Fuel: 0.9, TireWearFL: 0.1, TireWearFR: 0.1, TireWearRL: 0.1, TireWearRR: 0.1, CurrentLap: 5 }), 5_000);
    expect(result.fuelPerLap).toBe(0);
    expect(result.tireWearPerLap).toBe(0);
  });

  test("applies fuel and tire policies independently from normal pace", () => {
    const measure = (eligibility: EligibilityDecisionSet) => {
      const tracker = new PitTracker();
      tracker.feed(pkt({ LapNumber: 1, Fuel: 1, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0 }), 5_000);
      completeLap(tracker, 1, {
        fuel: 0.9,
        wearFL: 0.1,
        wearFR: 0.1,
        wearRL: 0.1,
        wearRR: 0.1,
        eligibility,
      });
      return tracker.feed(pkt({ LapNumber: 2, Fuel: 0.9, TireWearFL: 0.1, TireWearFR: 0.1, TireWearRL: 0.1, TireWearRR: 0.1, CurrentLap: 5 }), 5_000);
    };

    const normalPaceRejected = measure(
      pitEligibility({
        "normal-pace": policyDecision("normal-pace", "ineligible"),
      }),
    );
    expect(normalPaceRejected.fuelPerLap).toBeCloseTo(0.1, 2);
    expect(normalPaceRejected.tireWearPerLap).toBeCloseTo(0.1, 2);

    const fuelRejected = measure(
      pitEligibility({
        "fuel-burn": policyDecision("fuel-burn", "ineligible"),
      }),
    );
    expect(fuelRejected.fuelPerLap).toBe(0);
    expect(fuelRejected.tireWearPerLap).toBeCloseTo(0.1, 2);

    const tireRejected = measure(
      pitEligibility({
        "tire-analysis": policyDecision("tire-analysis", "unknown"),
      }),
    );
    expect(tireRejected.fuelPerLap).toBeCloseTo(0.1, 2);
    expect(tireRejected.tireWearPerLap).toBe(0);
  });

  test("tire: per-tire rolling average of last 3 laps, worst governs", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0 }), 5000);

    // 3 laps: FL wears 0.08, 0.10, 0.12 → avg FL = 0.10
    completeLap(tracker, 1, { fuel: 0.9, wearFL: 0.08, wearFR: 0.05, wearRL: 0.04, wearRR: 0.04 });
    completeLap(tracker, 2, { fuel: 0.8, wearFL: 0.18, wearFR: 0.1, wearRL: 0.08, wearRR: 0.08 });
    completeLap(tracker, 3, { fuel: 0.7, wearFL: 0.3, wearFR: 0.15, wearRL: 0.12, wearRR: 0.12 });

    const r = tracker.feed(pkt({ LapNumber: 4, Fuel: 0.7, TireWearFL: 0.3, TireWearFR: 0.15, TireWearRL: 0.12, TireWearRR: 0.12, CurrentLap: 5 }), 5000);
    // FL avg = (0.08 + 0.10 + 0.12) / 3 = 0.10
    expect(r.tireWearPerLap).toBeCloseTo(0.1, 2);
    // health = 1 - 0.30 = 0.70, bad threshold = 0.40, wear until bad = 0.30
    // At 0.10/lap → 3.0 laps
    expect(r.tireLapsToBad).toBeCloseTo(3.0, 0);
  });

  test("tireLapsToCritical uses 20% health threshold", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0 }), 5000);
    completeLap(tracker, 1, { fuel: 0.9, wearFL: 0.1, wearFR: 0.1, wearRL: 0.1, wearRR: 0.1 });

    const r = tracker.feed(pkt({ LapNumber: 2, Fuel: 0.9, TireWearFL: 0.1, TireWearFR: 0.1, TireWearRL: 0.1, TireWearRR: 0.1, CurrentLap: 5 }), 5000);
    // health = 0.90, critical = 0.20, wear until critical = 0.70
    // At 0.10/lap → 7.0 laps
    expect(r.tireLapsToCritical).toBeCloseTo(7.0, 0);
  });

  test("setTireThresholds changes bad health target", () => {
    const tracker = new PitTracker();
    tracker.setTireThresholds(0.7); // ACC stricter

    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0 }), 5000);
    completeLap(tracker, 1, { fuel: 0.9, wearFL: 0.1, wearFR: 0.08, wearRL: 0.06, wearRR: 0.06 });

    const r = tracker.feed(pkt({ LapNumber: 2, Fuel: 0.9, TireWearFL: 0.1, TireWearFR: 0.08, TireWearRL: 0.06, TireWearRR: 0.06, CurrentLap: 5 }), 5000);
    // health = 0.90, bad = 0.70, wear until bad = 0.20, at 0.10/lap → 2.0
    expect(r.tireLapsToBad).toBeCloseTo(2.0, 0);
    // Critical unchanged: 7.0
    expect(r.tireLapsToCritical).toBeCloseTo(7.0, 0);
  });

  test("returns 0 when already past threshold", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0.5, TireWearFR: 0.5, TireWearRL: 0.5, TireWearRR: 0.5, CurrentLap: 0 }), 5000);
    completeLap(tracker, 1, { fuel: 0.9, wearFL: 0.65, wearFR: 0.65, wearRL: 0.65, wearRR: 0.65 });

    const r = tracker.feed(pkt({ LapNumber: 2, Fuel: 0.9, TireWearFL: 0.65, TireWearFR: 0.65, TireWearRL: 0.65, TireWearRR: 0.65, CurrentLap: 5 }), 5000);
    // health = 0.35, below bad (0.40) → 0
    expect(r.tireLapsToBad).toBe(0);
    // Above critical (0.20): 0.15 / 0.15 = 1.0
    expect(r.tireLapsToCritical).toBeCloseTo(1.0, 0);
  });

  test("pitInLaps uses whichever runs out first", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0 }), 5000);
    completeLap(tracker, 1, { fuel: 0.9, wearFL: 0.1, wearFR: 0.1, wearRL: 0.1, wearRR: 0.1 });

    const r = tracker.feed(pkt({ LapNumber: 2, Fuel: 0.9, TireWearFL: 0.1, TireWearFR: 0.1, TireWearRL: 0.1, TireWearRR: 0.1, CurrentLap: 5 }), 5000);
    // Fuel: 0.90 / 0.10 = 9.0
    // Tires to bad: (0.90 - 0.40) / 0.10 = 5.0
    expect(r.limitedBy).toBe("tires");
    expect(r.pitInLaps).toBeCloseTo(5.0, 0);
  });

  test("outlier rejection: skips formation lap (>2x average lap time)", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0 }), 5000);

    // Normal lap: 90s, 0.10 fuel
    completeLap(tracker, 1, { fuel: 0.9, wearFL: 0.05, wearFR: 0.05, wearRL: 0.05, wearRR: 0.05, lapTime: 90 });
    // Another normal lap
    completeLap(tracker, 2, { fuel: 0.8, wearFL: 0.1, wearFR: 0.1, wearRL: 0.1, wearRR: 0.1, lapTime: 91 });

    // Formation/safety car lap: 200s (>2x 90.5 avg) — should be excluded
    completeLap(tracker, 3, { fuel: 0.78, wearFL: 0.11, wearFR: 0.11, wearRL: 0.11, wearRR: 0.11, lapTime: 200 });

    const r = tracker.feed(pkt({ LapNumber: 4, Fuel: 0.78, CurrentLap: 5 }), 5000);
    // Fuel should still be ~0.10 (formation lap's 0.02 excluded)
    expect(r.fuelPerLap).toBeCloseTo(0.1, 1);
  });

  test("outlier rejection: skips refuel lap (fuel increased)", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 0.5, CurrentLap: 0 }), 5000);
    // Normal lap
    completeLap(tracker, 1, { fuel: 0.4, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0, lapTime: 90 });
    // Pit stop: fuel increased from 0.40 to 0.90
    completeLap(tracker, 2, { fuel: 0.9, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0, lapTime: 90 });

    const r = tracker.feed(pkt({ LapNumber: 3, Fuel: 0.9, CurrentLap: 5 }), 5000);
    // Should only have the first lap's 0.10 usage, pit lap excluded
    expect(r.fuelPerLap).toBeCloseTo(0.1, 2);
  });

  test("refuel and zero-fuel laps retain tire evidence without changing fuel history", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 0.5, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0 }), 5000);
    completeLap(tracker, 1, { fuel: 0.4, wearFL: 0.1, wearFR: 0.1, wearRL: 0.1, wearRR: 0.1 });
    expect(tracker.getDebugState()).toMatchObject({ fuelHistoryLength: 1, tireWearHistoryLength: 1 });

    completeLap(tracker, 2, { fuel: 0.9, wearFL: 0.2, wearFR: 0.2, wearRL: 0.2, wearRR: 0.2 });
    expect(tracker.getDebugState()).toMatchObject({ fuelHistoryLength: 1, tireWearHistoryLength: 2 });

    completeLap(tracker, 3, { fuel: 0.9, wearFL: 0.3, wearFR: 0.3, wearRL: 0.3, wearRR: 0.3 });
    expect(tracker.getDebugState()).toMatchObject({ fuelHistoryLength: 1, tireWearHistoryLength: 3 });
  });

  test("long and short lap-time outliers reject both fuel and tire evidence", () => {
    const tracker = new PitTracker();
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0 }), 5000);
    completeLap(tracker, 1, { fuel: 0.9, wearFL: 0.05, wearFR: 0.05, wearRL: 0.05, wearRR: 0.05, lapTime: 90 });
    completeLap(tracker, 2, { fuel: 0.8, wearFL: 0.1, wearFR: 0.1, wearRL: 0.1, wearRR: 0.1, lapTime: 90 });
    expect(tracker.getDebugState()).toMatchObject({ fuelHistoryLength: 2, tireWearHistoryLength: 2 });

    completeLap(tracker, 3, { fuel: 0.7, wearFL: 0.15, wearFR: 0.15, wearRL: 0.15, wearRR: 0.15, lapTime: 200 });
    expect(tracker.getDebugState()).toMatchObject({ fuelHistoryLength: 2, tireWearHistoryLength: 2 });

    completeLap(tracker, 4, { fuel: 0.6, wearFL: 0.2, wearFR: 0.2, wearRL: 0.2, wearRR: 0.2, lapTime: 20 });
    expect(tracker.getDebugState()).toMatchObject({ fuelHistoryLength: 2, tireWearHistoryLength: 2 });
  });
});

describe("PitTracker history seeding policy", () => {
  test("Forza seeds fuel only when compound history is not comparable", () => {
    expect(forzaServerAdapter.runtime.pit.seedFuelFromHistory).toBe(true);
    expect(forzaServerAdapter.runtime.pit.seedTireWearFromHistory).toBe(false);
  });

  test("F1 seeds tires only when fuel history is not relevant", () => {
    expect(f1ServerAdapter.runtime.pit.seedFuelFromHistory).toBe(false);
    expect(f1ServerAdapter.runtime.pit.seedTireWearFromHistory).toBe(true);
  });

  test("ACC seeds both histories", () => {
    expect(accServerAdapter.runtime.pit.seedFuelFromHistory).toBe(true);
    expect(accServerAdapter.runtime.pit.seedTireWearFromHistory).toBe(true);
  });

  test("continues past newer fuel-only laps until independent tire quota is filled", async () => {
    const historicalLap = (id: number, fuelStatus: EligibilityDecision["status"], tireStatus: EligibilityDecision["status"]): LapMeta => {
      const packets = qualityPackets(100);
      const generated = finalizeLapQualityGeneration(summarize(packets), "test-pit-history", {
        lapNumber: id,
        rawByteOffset: null,
        rawFrameCount: packets.length,
      });
      return {
        id,
        sessionId: 1,
        lapNumber: id,
        lapTime: 90,
        isValid: true,
        phase: "flying",
        conditions: [],
        paceEligibility: "eligible",
        createdAt: "2026-01-01T00:00:00.000Z",
        pi: 900,
        gameId: "acc",
        carOrdinal: 901,
        trackOrdinal: 902,
        quality: generated.quality,
        eligibility: {
          ...generated.eligibility,
          "fuel-burn": policyDecision("fuel-burn", fuelStatus),
          "tire-analysis": policyDecision("tire-analysis", tireStatus),
        },
        qualityGeneration: generated.quality.provenance.outputGeneration,
        qualityStale: false,
      };
    };
    const candidates = [
      historicalLap(6, "eligible", "ineligible"),
      historicalLap(5, "eligible", "ineligible"),
      historicalLap(4, "eligible", "ineligible"),
      historicalLap(3, "eligible", "ineligible"),
      historicalLap(2, "eligible", "ineligible"),
      historicalLap(1, "ineligible", "eligible"),
    ];
    const reads: number[] = [];
    const getPitHistory = spyOn(LapReadQueries, "getLapMetaForPitHistory").mockResolvedValue(candidates);
    const queryLapTelemetry = spyOn(TelemetryReplay, "queryLapTelemetryBySemanticId").mockImplementation(async (id) => {
      reads.push(id);
      const metadata = candidates.find((lap) => lap.id === id);
      if (!metadata) return null;
      const fuelUsed = id === 6 ? 0.1 : id === 5 ? 0.2 : 0;
      const tireWear = id === 1 ? 0.04 : 0;
      return {
        lapId: id,
        requestedSemanticIds: ["fuel.fuel", "tires.tire-wear"],
        envelopes: Array.from({ length: 50 }, (_, index) => {
          const fraction = index / 49;
          return {
            sequence: BigInt(index),
            observedAt: { domain: "session" as const, milliseconds: index },
            receivedAt: { domain: "wall-clock" as const, milliseconds: index },
            simulator: "acc" as const,
            catalogVersion: "test",
            catalogHash: "test",
            catalogSchemaVersion: "test",
            parserVersion: "test",
            resolverVersion: "test",
            derivationVersion: "test",
            values: [
              {
                semanticId: "fuel.fuel",
                value: 1 - fuelUsed * fraction,
                state: "ok" as const,
                freshness: "fresh" as const,
              },
              {
                semanticId: "tires.tire-wear",
                value: [tireWear * fraction, tireWear * fraction, tireWear * fraction, tireWear * fraction],
                state: "ok" as const,
                freshness: "fresh" as const,
              },
            ],
          };
        }),
      } as never;
    });

    try {
      const tracker = new PitTracker();
      await tracker.seedFromHistory(902, 901, 900, "acc", accServerAdapter.runtime.pit);
      expect(getPitHistory).toHaveBeenCalledWith(902, 901, 900, "acc", 200);
      expect(queryLapTelemetry.mock.calls.map(([id, semanticIds]) => [id, semanticIds])).toEqual([
        [6, ["fuel.fuel", "tires.tire-wear"]],
        [5, ["fuel.fuel", "tires.tire-wear"]],
        [1, ["fuel.fuel", "tires.tire-wear"]],
      ]);
      expect(tracker.getDebugState()).toMatchObject({ fuelHistoryLength: 2, tireWearHistoryLength: 1 });
      expect(reads).toEqual([6, 5, 1]);
    } finally {
      getPitHistory.mockRestore();
      queryLapTelemetry.mockRestore();
    }
  });

  test("seeded fuel data produces immediate estimate", () => {
    const tracker = new PitTracker();
    tracker._seedForTest([0.08, 0.09], []);

    // No laps completed yet, but fuel history is seeded
    tracker.feed(pkt({ LapNumber: 1, Fuel: 0.5, CurrentLap: 0 }), 5000);
    const r = tracker.feed(pkt({ LapNumber: 1, Fuel: 0.5, CurrentLap: 10 }), 5000);

    expect(r.fuelPerLap).toBeCloseTo(0.085, 2);
    expect(r.fuelLapsRemaining).not.toBeNull();
    // Tires not seeded — no tire estimate
    expect(r.tireWearPerLap).toBe(0);
    expect(r.tireLapsToBad).toBeNull();
  });

  test("seeded tire data produces immediate tire estimate (F1/ACC)", () => {
    const tracker = new PitTracker();
    tracker._seedForTest([], [{ fl: 0.03, fr: 0.03, rl: 0.02, rr: 0.02 }]);

    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0.1, TireWearFR: 0.1, TireWearRL: 0.08, TireWearRR: 0.08, CurrentLap: 0 }), 5000);
    const r = tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0.1, TireWearFR: 0.1, TireWearRL: 0.08, TireWearRR: 0.08, CurrentLap: 10 }), 5000);

    // Worst tire wear rate = FL 0.03/lap
    expect(r.tireWearPerLap).toBeCloseTo(0.03, 2);
    expect(r.tireLapsToBad).not.toBeNull();
    expect(r.tireLapsToCritical).not.toBeNull();
  });

  test("fresh session laps replace seeded data via rolling average", () => {
    const tracker = new PitTracker();
    // Seed with 0.05 fuel/lap
    tracker._seedForTest([0.05, 0.05], []);

    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, CurrentLap: 0 }), 5000);
    // Complete 3 laps using 0.10 fuel each
    completeLap(tracker, 1, { fuel: 0.9, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0 });
    completeLap(tracker, 2, { fuel: 0.8, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0 });
    completeLap(tracker, 3, { fuel: 0.7, wearFL: 0, wearFR: 0, wearRL: 0, wearRR: 0 });

    const r = tracker.feed(pkt({ LapNumber: 4, Fuel: 0.7, CurrentLap: 5 }), 5000);
    // Rolling 5: [0.05, 0.05, 0.10, 0.10, 0.10] → avg = 0.08
    expect(r.fuelPerLap).toBeCloseTo(0.08, 2);
  });
});

describe("PitTracker wear curve interpolation", () => {
  /** Build packets simulating a lap with non-uniform wear profile. */
  function makeLapPackets(opts: {
    trackLen: number;
    distStart: number;
    count: number;
    /** Per-tire wear at each fraction [0,1] of the lap. Returns delta from start. */
    wearProfile: (frac: number) => [number, number, number, number];
  }): TelemetryPacket[] {
    const packets: TelemetryPacket[] = [];
    for (let i = 0; i < opts.count; i++) {
      const frac = i / (opts.count - 1);
      const [fl, fr, rl, rr] = opts.wearProfile(frac);
      packets.push(
        pkt({
          DistanceTraveled: opts.distStart + frac * opts.trackLen,
          CurrentLap: frac * 90,
          LapNumber: 1,
          TireWearFL: fl,
          TireWearFR: fr,
          TireWearRL: rl,
          TireWearRR: rr,
        }),
      );
    }
    return packets;
  }

  test("updateWearCurves builds reference from completed lap", () => {
    const tracker = new PitTracker();
    const packets = makeLapPackets({
      trackLen: 1000,
      distStart: 0,
      count: 200,
      wearProfile: (f) => [f * 0.1, f * 0.08, f * 0.06, f * 0.06],
    });
    tracker.updateWearCurves(packets, 0);
    const ref = tracker._getRefWearCurve();
    expect(ref).not.toBeNull();
    expect(ref!.length).toBe(1000);
    // Total wear should match profile endpoint
    expect(ref!.totalWear[0]).toBeCloseTo(0.1, 2); // FL
    expect(ref!.totalWear[1]).toBeCloseTo(0.08, 2); // FR
  });

  test("averaged reference from 3 laps", () => {
    const tracker = new PitTracker();
    // 3 laps with varying FL wear: 0.08, 0.10, 0.12 → avg 0.10
    for (const total of [0.08, 0.1, 0.12]) {
      const packets = makeLapPackets({
        trackLen: 1000,
        distStart: 0,
        count: 200,
        wearProfile: (f) => [f * total, f * 0.05, f * 0.04, f * 0.04],
      });
      tracker.updateWearCurves(packets, 0);
    }
    const ref = tracker._getRefWearCurve();
    expect(ref).not.toBeNull();
    expect(ref!.totalWear[0]).toBeCloseTo(0.1, 2); // FL averaged
  });

  test("curve-based estimate adjusts mid-lap based on wear deviation", () => {
    const tracker = new PitTracker();
    // Build reference: uniform 0.10 FL wear over 1000m
    const packets = makeLapPackets({
      trackLen: 1000,
      distStart: 0,
      count: 200,
      wearProfile: (f) => [f * 0.1, f * 0.05, f * 0.04, f * 0.04],
    });
    tracker.updateWearCurves(packets, 0);

    // Init tracker state
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0.2, TireWearFR: 0.1, TireWearRL: 0.08, TireWearRR: 0.08, CurrentLap: 0 }), 1000);
    // Simulate next lap boundary to set liveWearAtLapStart
    tracker.feed(pkt({ LapNumber: 1, Fuel: 1.0, TireWearFL: 0.2, TireWearFR: 0.1, TireWearRL: 0.08, TireWearRR: 0.08, CurrentLap: 85 }), 1000);
    tracker.feed(pkt({ LapNumber: 2, Fuel: 0.9, TireWearFL: 0.2, TireWearFR: 0.1, TireWearRL: 0.08, TireWearRR: 0.08, CurrentLap: 0 }), 1000);

    // At 500m (50%), ref says FL should have worn 0.05.
    // If actual FL is 0.06 (wore 0.01 more than expected), projected = 0.10 + 0.01 = 0.11
    const r = tracker.feed(
      pkt({
        LapNumber: 2,
        DistanceTraveled: 500,
        TireWearFL: 0.26, // 0.20 + 0.06 delta
        TireWearFR: 0.12,
        TireWearRL: 0.1,
        TireWearRR: 0.1,
        CurrentLap: 45,
        Fuel: 0.89,
      }),
      1000,
      0,
    );

    // FL projected wear per lap should be ~0.11 (ref 0.10 + deviation 0.01)
    expect(r.tireEstimates.wearPerLap[0]).toBeCloseTo(0.11, 1);
  });

  test("falls back to rolling average when no curves", () => {
    const tracker = new PitTracker();
    // No curves built — just per-lap history
    tracker._seedForTest([], [{ fl: 0.1, fr: 0.08, rl: 0.06, rr: 0.06 }]);
    tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0.1, TireWearFR: 0.08, TireWearRL: 0.06, TireWearRR: 0.06, CurrentLap: 0, Fuel: 1 }), 5000);
    const r = tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0.1, TireWearFR: 0.08, TireWearRL: 0.06, TireWearRR: 0.06, CurrentLap: 10, Fuel: 1 }), 5000);
    // Should use rolling average fallback
    expect(r.tireWearPerLap).toBeCloseTo(0.1, 2); // worst = FL
    expect(r.tireLapsToBad).not.toBeNull();
  });

  test("non-uniform wear profile gives better mid-lap estimates", () => {
    const tracker = new PitTracker();
    // Reference: first half of track causes 80% of wear (heavy braking zone)
    const packets = makeLapPackets({
      trackLen: 1000,
      distStart: 0,
      count: 200,
      wearProfile: (f) => {
        // 80% of wear in first 50% of distance
        const w = f < 0.5 ? f * 2 * 0.08 : 0.08 + (f - 0.5) * 2 * 0.02;
        return [w, w * 0.8, w * 0.6, w * 0.6];
      },
    });
    tracker.updateWearCurves(packets, 0);

    tracker.feed(pkt({ LapNumber: 1, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0, Fuel: 1 }), 1000);
    tracker.feed(pkt({ LapNumber: 1, CurrentLap: 85, Fuel: 0.95 }), 1000);
    tracker.feed(pkt({ LapNumber: 2, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0, CurrentLap: 0, Fuel: 0.9 }), 1000);

    // At 750m (75% through), past the heavy zone — reference says most wear already happened
    // On pace: FL ref at 750m ≈ 0.08 + 0.5*0.02 = 0.09
    // Actual FL = 0.09 (on pace) → deviation = 0, projected = totalWear (0.10)
    const r = tracker.feed(
      pkt({
        LapNumber: 2,
        DistanceTraveled: 750,
        TireWearFL: 0.09,
        TireWearFR: 0.072,
        TireWearRL: 0.054,
        TireWearRR: 0.054,
        CurrentLap: 67,
        Fuel: 0.88,
      }),
      1000,
      0,
    );

    // Projected FL ≈ 0.10 (reference total + ~0 deviation)
    expect(r.tireEstimates.wearPerLap[0]).toBeCloseTo(0.1, 1);
  });
});

describe("PitTracker semantic timing", () => {
  test("uses simulation elapsed time for completed-lap pace", () => {
    const tracker = new PitTracker();
    tracker.feedSemantic(
      semanticSample(
        {
          "timing.lap-number": 1,
          "timing.current-lap": 90,
          "fuel.fuel": 1,
          "timing.distance-traveled": 5_000,
          "tires.tire-wear": [0, 0, 0, 0],
        },
        1_000,
      ),
      5_000,
    );
    tracker.acceptCompletedLap(pitEligibility());
    tracker.feedSemantic(
      semanticSample(
        {
          "timing.lap-number": 2,
          "timing.current-lap": 0,
          "fuel.fuel": 0.9,
          "timing.distance-traveled": 5_010,
          "tires.tire-wear": [0.01, 0.01, 0.01, 0.01],
        },
        1_001,
      ),
      5_000,
    );

    expect(tracker.getDebugState()).toMatchObject({ lapTimeHistoryLength: 1 });
  });
});
