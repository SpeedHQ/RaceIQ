import { describe, expect, test } from "bun:test";
import { aggregateRacePlanEvidence } from "@raceiq/shared/racing/live/race-plan-evidence";
import type { RacePlan } from "@raceiq/shared/racing/live/race-plan";
import type { PitEstimateRecord, StintSummary } from "@raceiq/shared/racing/live/strategy";
import { buildStrategyAdherence, resolveAdherenceCheckpoints } from "../../ui/strategy-adherence-model";
import { projectRacePlanStint } from "../../ui/race-plan-projection";
import type { BuildStrategyAdherenceInput, ResolveAdherenceCheckpointsInput } from "../../contracts/strategy-adherence";

const rate = (value: number | null, unit: "L/lap" | "wearFraction/lap" | "energyFraction/lap" = "L/lap") => ({ value, unit, eligibleLaps: 4, source: "history" as const, provisional: false, unavailableReason: null });
const summary: StintSummary = {
  id: "stint", sessionId: 7, driverKey: "driver", ordinal: 1, status: "active", gameId: "acc", trackId: "track", carId: "car", pi: null,
  compounds: ["medium", "medium", "medium", "medium"], compatibility: { fuelSemanticVersion: "fuel-v1", tireSemanticVersions: ["tire-v1", "tire-v1", "tire-v1", "tire-v1"], setupKey: null, conditions: { weather: null, airTemperatureC: null, trackTemperatureC: null } },
  startedAt: "2026-01-01T00:00:00Z", endedAt: null, firstLapNumber: 1, lastLapNumber: 5, boundary: { reason: "active", confidence: "observed" }, completedLaps: 5,
  fuel: rate(2), tires: [0, 1, 2, 3].map(() => rate(0.02, "wearFraction/lap")) as StintSummary["tires"], measuredFuelUsed: 10, fuelUnit: "L", fuelCoverage: "complete", averageLapSeconds: 90, paceLaps: 5, exclusions: [], algorithmVersion: "v1", revision: 1,
};
const plan: RacePlan = {
  id: "plan", name: "test", gameId: "acc", carId: "car", trackId: "track", pi: null, totalLaps: 20, raceLength: { mode: "laps" }, fuelUnit: "L", notes: "",
  generation: { fuelCapacity: 40, fuelReserve: 2, energyReserveFraction: 0 },
  stints: [{ endLap: 10, startFuel: 22, compounds: ["medium", "medium", "medium", "medium"], sourceSessionId: 8, sourceStintId: "source", evidence: summary },
    { endLap: 20, startFuel: 22, compounds: ["medium", "medium", "medium", "medium"], sourceSessionId: 8, sourceStintId: "source", evidence: summary }],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
function record(lapId: number, sequence: number, fuel: number | null, wear: number | null, overrides: Partial<PitEstimateRecord> = {}): PitEstimateRecord {
  return { id: `e-${sequence}`, sessionId: 7, driverKey: "driver", stintId: "stint", gameId: "acc", trackId: "track", carId: "car", pi: null,
    compounds: ["medium", "medium", "medium", "medium"], observedAt: "2026-01-01T00:00:00Z", sourceOrder: { epochOrdinal: 0, sequence }, sourceCoordinate: { epoch: "e", domain: "session", milliseconds: sequence }, trigger: "lap-completed", pitInLaps: null,
    estimatedPitTime: { sessionElapsedSeconds: null }, limitedBy: null, tyreChangeSuggestion: "unavailable", fuelChangeSuggestion: "unavailable", fuel: rate(2), tires: [0, 1, 2, 3].map(() => rate(0.02, "wearFraction/lap")) as PitEstimateRecord["tires"],
    sourceSnapshot: { fuelRemaining: fuel, fuelUnit: "L", wear: [wear, wear, wear, wear], lapId }, compatibility: summary.compatibility, baseline: null, algorithmVersion: "v1", ...overrides };
}
const base = (overrides: Partial<BuildStrategyAdherenceInput> = {}): BuildStrategyAdherenceInput => ({ plan, currentLap: 6, lapFraction: 0.5, fuelRemaining: 25, fuelUnit: "L", fuelCapacity: 40,
  tireWear: [0.2, 0.2, 0.2, 0.2], virtualEnergy: null, strategy: { sessionId: 7, driverKey: "driver", stintId: "stint", revision: 1, historyRevision: 1, fuel: rate(2), tires: [0, 1, 2, 3].map(() => rate(0.02, "wearFraction/lap")) as StintSummary["tires"], baseline: null, persistence: "ok" },
  currentStint: summary, checkpoints: [], thresholds: [0, 1, 2, 3].map(() => ({ cliffPct: 20, deadPct: 10 })) as BuildStrategyAdherenceInput["thresholds"], evidenceLoading: false, evidenceError: false, ...overrides });
const liveRate = (value: number, unit: "L/lap" | "wearFraction/lap" = "L/lap") => ({ ...rate(value, unit), source: "current-stint" as const });
const resolverInput = (estimates: PitEstimateRecord[]): ResolveAdherenceCheckpointsInput => ({ plan, sessionId: 7, driverKey: "driver", stintId: "stint", estimates, laps: [1, 2, 3, 4].map((id) => ({ id, sessionId: 7, lapNumber: id })) });


describe("strategy adherence model", () => {
  test("F1 windows depend on tire evidence, not fuel values or fuel settings", () => {
    const f1Evidence: StintSummary = { ...summary, gameId: "f1-2025", fuelUnit: "tankFraction",
      fuel: { ...rate(0.04), unit: "tankFraction/lap" }, compatibility: { ...summary.compatibility, fuelSemanticVersion: "f1-fuel" } };
    const f1Plan: RacePlan = { ...plan, gameId: "f1-2025", fuelUnit: "tankFraction",
      generation: { fuelCapacity: 1, fuelReserve: 0.05, energyReserveFraction: 0 },
      stints: plan.stints.map((stint) => ({ ...stint, startFuel: 0.8, evidence: f1Evidence })) };
    const strategy = { ...base().strategy!, fuel: { ...rate(0.04), unit: "tankFraction/lap" as const }, tires: [0, 1, 2, 3].map(() => liveRate(0.02, "wearFraction/lap")) as StintSummary["tires"] };
    const result = (fuelRemaining: number | null, fuelRate: number | null, generation: RacePlan["generation"]) => buildStrategyAdherence(base({
      plan: { ...f1Plan, generation }, currentStint: f1Evidence, fuelRemaining, fuelUnit: "tankFraction", fuelCapacity: null,
      strategy: { ...strategy, fuel: { ...strategy.fuel, value: fuelRate } },
    }));
    const low = result(0.001, 0.8, f1Plan.generation);
    const missing = result(null, null, undefined);
    const high = result(1, 0.8, f1Plan.generation);
    expect([low.window.earliestLap, low.window.latestLap]).toEqual([missing.window.earliestLap, missing.window.latestLap]);
    expect([low.window.earliestLap, low.window.latestLap]).toEqual([high.window.earliestLap, high.window.latestLap]);
    expect(low.window.state).toBe(missing.window.state);
    expect(low.window.state).toBe(high.window.state);
    expect(high.fuel.actual.at(-1)?.value).toBe(1);
    expect(low.state).toBe(missing.state);
    expect(low.state).toBe(high.state);
    expect(result(0.4, 0.04, f1Plan.generation).fuel.reference).toEqual([]);
    const resetProjection = (resetLap: number) => buildStrategyAdherence(base({
      plan: f1Plan, currentStint: f1Evidence, fuelUnit: "tankFraction", fuelRemaining: 0.55, fuelCapacity: null,
      checkpoints: [2, 3, 4, 5].map((lap) => ({
        lap, fuelRemaining: 0.75 - (lap - 2) * 0.035,
        tireWear: [0, 1, 2, 3].map(() => lap < resetLap ? 0.1 + (lap - 2) * 0.02 : 0.03 + (lap - resetLap) * 0.02) as [number, number, number, number],
        compounds: f1Evidence.compounds,
      })),
      tireWear: [0.11, 0.11, 0.11, 0.11],
    }));
    const earlyReset = resetProjection(3);
    const lateReset = resetProjection(4);
    expect(earlyReset.tires[0].reference[0]?.lap).toBe(3);
    expect(lateReset.tires[0].reference[0]?.lap).toBe(4);
    expect(earlyReset.fuel.actual).toEqual(lateReset.fuel.actual);
    expect(earlyReset.fuel.actual.every((point) => !point.breakBefore)).toBe(true);
    const moreWear = buildStrategyAdherence(base({ plan: f1Plan, currentStint: f1Evidence, fuelUnit: "tankFraction", fuelRemaining: 0.4, fuelCapacity: null,
      strategy: { ...strategy, fuel: { ...strategy.fuel, value: 0.04 }, tires: [0, 1, 2, 3].map(() => liveRate(0.06, "wearFraction/lap")) as StintSummary["tires"] } }));
    expect(moreWear.window.state).toBe("upcoming");
    expect(moreWear.window.latestLap).toBe(15);
  });
  test("resolves exact-identity checkpoints by mapped completed lap, deduplicating latest snapshot", () => {
    const checkpoints = resolveAdherenceCheckpoints(resolverInput([record(1, 1, 40, 0.1), record(1, 3, 39, 0.12), record(2, 2, 37, 0.14), record(3, 4, 35, 0.16), record(4, 5, 33, 0.18)]));
    expect(checkpoints.map((item) => [item.lap, item.fuelRemaining])).toEqual([[1, 39], [2, 37], [3, 35], [4, 33]]);
    expect(resolveAdherenceCheckpoints(resolverInput([record(1, 1, 40, 0.1, { driverKey: "other" })]))).toEqual([]);
  });
  test("keeps incompatible fuel unit and invalid wheel readings missing", () => {
    const recordOne = record(1, 1, 40, 0.2, { sourceSnapshot: { fuelRemaining: 0.5, fuelUnit: "tankFraction", wear: [0.2, 2, -1, NaN], lapId: 1 } });
    expect(resolveAdherenceCheckpoints(resolverInput([recordOne]))[0]).toEqual({ lap: 1, fuelRemaining: null, tireWear: [0.2, null, null, null], compounds: ["medium", "medium", "medium", "medium"] });
  });
  test("requires measured intervals and handles two-interval rates, independent resets and gaps", () => {
    const sparse = buildStrategyAdherence(base({ checkpoints: [{ lap: 4, fuelRemaining: 30, tireWear: [0.1, 0.1, 0.1, 0.1], compounds: summary.compounds }] }));
    expect(sparse.fuel.observedRate).toBeNull();
    expect(sparse.state).toBe("unknown");
    const enough = buildStrategyAdherence(base({ checkpoints: [
      { lap: 1, fuelRemaining: 40, tireWear: [0.1, 0.1, 0.1, 0.1], compounds: summary.compounds },
      { lap: 2, fuelRemaining: 38, tireWear: [0.12, 0.12, 0.12, 0.12], compounds: summary.compounds },
      { lap: 3, fuelRemaining: 36, tireWear: [0.14, 0.14, 0.14, 0.14], compounds: summary.compounds },
      { lap: 5, fuelRemaining: 40, tireWear: [0.1, 0.14, 0.16, 0.16], compounds: summary.compounds },
      { lap: 6, fuelRemaining: 38, tireWear: [0.12, 0.16, 0.18, 0.18], compounds: summary.compounds },
      { lap: 7, fuelRemaining: 36, tireWear: [0.14, 0.18, 0.2, 0.2], compounds: summary.compounds },
    ] }));
    expect(enough.fuel.observedRate).toBeNull();
    expect(enough.fuel.actual.at(-2)?.breakBefore).toBe(true);
    expect(enough.tires[0].actual.at(-2)?.breakBefore).toBe(true);
    expect(enough.tires[1].actual.at(-2)?.breakBefore).toBe(true);
  });
  test("does not invent position, preserves saved stop markers, recalculates around current resources", () => {
    const missingPosition = buildStrategyAdherence(base({ lapFraction: null }));
    expect(missingPosition.currentPosition).toBeNull();
    expect(missingPosition.window.reason).toBe("position");
    const savedPlan = structuredClone(plan);
    const normal = buildStrategyAdherence(base());
    const early = buildStrategyAdherence(base({ fuelRemaining: 35 }));
    expect(normal.plannedStopLaps).toEqual([10]);
    expect(early.plannedStopLaps).toEqual(normal.plannedStopLaps);
    expect(normal.window.latestLap).not.toBe(early.window.latestLap);
    expect(plan).toEqual(savedPlan);
    expect(plan.stints[0]?.startFuel).toBe(22);
  });
  test("keeps fuel-only service independent from tires, guards zero usage, finish and missing data", () => {
    const zeroSummary = { ...summary, fuel: rate(0), tires: [0, 1, 2, 3].map(() => rate(0, "wearFraction/lap")) as StintSummary["tires"] };
    const zeroPlan = { ...plan, stints: plan.stints.map((stint) => ({ ...stint, evidence: zeroSummary })) };
    const zeros = buildStrategyAdherence(base({ plan: zeroPlan, strategy: { ...base().strategy!, fuel: rate(0), tires: [0, 1, 2, 3].map(() => rate(0, "wearFraction/lap")) as StintSummary["tires"] }, currentStint: zeroSummary }));
    expect(zeros.window.state).toBe("finish");
    const exhausted = buildStrategyAdherence(base({ plan: zeroPlan, currentStint: zeroSummary, strategy: { ...base().strategy!, fuel: rate(2), tires: [0, 1, 2, 3].map(() => rate(0, "wearFraction/lap")) as StintSummary["tires"] }, fuelRemaining: 2, tireWear: [0.1, 0.1, 0.1, 0.1] }));
    expect(exhausted.fuel.state).toBe("over");
    expect(exhausted.tires[0].state).not.toBe("over");
    expect(exhausted.window.state).toBe("overdue");
    const noFuel = buildStrategyAdherence(base({ fuelRemaining: null }));
    expect(noFuel.window.state).toBe("unknown");
    expect(noFuel.tires[0].actual).toEqual([{ lap: 5.5, value: 0.2, breakBefore: false }]);
    expect(noFuel.state).toBe("unknown");
    const finish = buildStrategyAdherence(base({ currentLap: 20, lapFraction: 0, fuelRemaining: 40, tireWear: [0, 0, 0, 0] }));
    expect(finish.window.state).toBe("finish");
  });
  test("requires LMU energy and configured capacity; incompatible identity cannot leak observations", () => {
    const energySummary = { ...summary, gameId: "lmu" as const, compatibility: { ...summary.compatibility, virtualEnergySemanticVersion: "energy-v1" }, virtualEnergy: rate(0.1, "energyFraction/lap") };
    const lmuPlan = { ...plan, gameId: "lmu" as const, stints: plan.stints.map((stint) => ({ ...stint, evidence: energySummary })) } as RacePlan;
    const lmu = buildStrategyAdherence(base({ plan: lmuPlan, currentStint: energySummary }));
    expect(lmu.window.reason).toBe("energy");
    const noSettings = buildStrategyAdherence(base({ plan: { ...plan, generation: null } }));
    expect(noSettings.window.reason).toBe("settings");
    const other = buildStrategyAdherence(base({ currentStint: { ...summary, driverKey: "other" }, fuelRemaining: 0, tireWear: [1, 1, 1, 1] }));
    expect(other.fuel.actual).toEqual([]);
    expect(other.state).toBe("unknown");
  });
  test("history rates stay provisional; missing live resources or lap fraction cannot be green", () => {
    const historyOnly = buildStrategyAdherence(base());
    expect(historyOnly.fuel.basis).toBe("plan");
    expect(historyOnly.state).toBe("unknown");
    expect(historyOnly.fuel.reference[0]).toEqual({ lap: 5.5, value: 25, breakBefore: false });
    expect(historyOnly.fuel.reference.at(-1)).toEqual({ lap: 18, value: 0, breakBefore: false });
    const missingFuel = buildStrategyAdherence(base({ fuelRemaining: null }));
    expect(missingFuel.fuel.state).toBe("unknown");
    expect(missingFuel.state).toBe("unknown");
    const missingPosition = buildStrategyAdherence(base({ lapFraction: null }));
    expect(missingPosition.state).toBe("unknown");
    const currentStrategy = { ...base().strategy!, fuel: liveRate(3), tires: [0, 1, 2, 3].map(() => liveRate(0.03, "wearFraction/lap")) as StintSummary["tires"] };
    const over = buildStrategyAdherence(base({ strategy: currentStrategy }));
    expect(over.fuel.observedRate).toBe(3);
    expect(over.state).toBe("over");
  });
  test("checkpoint deltas never replace eligible current-stint aggregate rates", () => {
    const checkpoints = [1, 2, 3].map((lap) => ({ lap, fuelRemaining: 40 - lap * 2, tireWear: [lap / 10, lap / 10, lap / 10, lap / 10] as [number, number, number, number], compounds: summary.compounds }));
    const result = buildStrategyAdherence(base({ checkpoints }));
    expect(result.fuel.observedRate).toBeNull();
    expect(result.fuel.eligibleLaps).toBe(0);
    expect(result.fuel.basis).toBe("plan");
  });
  test("null semantic versions cannot create tire evidence; physical capacity below configured load blocks window", () => {
    const noSemantics = buildStrategyAdherence(base({ currentStint: { ...summary, compatibility: { ...summary.compatibility, tireSemanticVersions: [null, null, null, null] } } }));
    expect(noSemantics.tires[0].plannedRate).toBeNull();
    const capacity = buildStrategyAdherence(base({ fuelCapacity: 30 }));
    expect(capacity.window.state).toBe("unknown");
    expect(capacity.window.reason).toBe("capacity");
  });
  test("lap-completed resolver uses lexical source ordering and rejects other triggers", () => {
    const first = record(1, 999_999, 39, 0.1, { sourceOrder: { epochOrdinal: 1, sequence: 999_999 } });
    const newer = record(1, 1, 37, 0.12, { sourceOrder: { epochOrdinal: 2, sequence: 1 } });
    const laterTrigger = record(1, 999_999_999, 35, 0.14, { trigger: "limiter-changed" });
    expect(resolveAdherenceCheckpoints(resolverInput([newer, first, laterTrigger]))[0]?.fuelRemaining).toBe(37);
  });
  test("fuel-only live reset reanchors fuel reference without resetting tire reference", () => {
    const input = base({ checkpoints: [{ lap: 5, fuelRemaining: 25, tireWear: [0.2, 0.2, 0.2, 0.2], compounds: summary.compounds }], fuelRemaining: 35 });
    const fuelOnlyService = buildStrategyAdherence(input);
    expect(fuelOnlyService.fuel.reference[0]).toEqual({ lap: 5.5, value: 35, breakBefore: false });
    expect(fuelOnlyService.tires[0].actual.at(-1)?.breakBefore).toBe(false);
    expect(fuelOnlyService.tires[0].reference[0]).toEqual({ lap: 5, value: 0.2, breakBefore: false });
    const sameLapReset = buildStrategyAdherence(base({ currentLap: 6, lapFraction: 0, checkpoints: input.checkpoints, fuelRemaining: 35 }));
    expect(sameLapReset.fuel.actual.at(-1)?.breakBefore).toBe(true);
    expect(sameLapReset.fuel.reference[0]).toEqual({ lap: 5, value: 35, breakBefore: false });
  });
  test("uses current planned phase baseline and leaves unsourced manual phase unavailable", () => {
    const baselineFor = (id: number, fuel: number, tire: number) => {
      const baseline = aggregateRacePlanEvidence([{
        ...summary, id: `phase-${id}`, sessionId: id, status: "completed", endedAt: "2026-01-01T00:10:00Z", fuel: { ...summary.fuel, value: fuel },
        tires: [0, 1, 2, 3].map(() => ({ ...rate(tire, "wearFraction/lap") })) as StintSummary["tires"],
      }], "any");
      if (!baseline) throw new Error("Expected complete phase evidence baseline");
      return baseline;
    };
    const firstBaseline = baselineFor(8, 1, 0.01);
    const secondBaseline = baselineFor(9, 3, 0.03);
    const phasedPlan: RacePlan = { ...plan, totalLaps: 20, stints: [
      { ...plan.stints[0]!, endLap: 10, evidence: null, baseline: firstBaseline },
      { ...plan.stints[1]!, endLap: 18, evidence: null, baseline: secondBaseline },
      { ...plan.stints[1]!, endLap: 20, sourceSessionId: null, sourceStintId: null, evidence: null, baseline: null },
    ] };
    const secondPhase = buildStrategyAdherence(base({ plan: phasedPlan, currentLap: 12 }));
    expect(secondPhase.fuel.plannedRate).toBeCloseTo(3, 8);
    const secondForecast = projectRacePlanStint(phasedPlan.stints[1]!, 10, phasedPlan, secondBaseline, () => ({ cliffPct: 70, deadPct: 50 }));
    expect(secondForecast.consumed).toBe(24);
    const manualForecast = projectRacePlanStint(phasedPlan.stints[2]!, 18, phasedPlan, null, () => ({ cliffPct: 70, deadPct: 50 }));
    expect(manualForecast.consumed).toBeNull();
    expect(secondPhase.tires.map((tire) => tire.plannedRate)).toEqual([0.03, 0.03, 0.03, 0.03]);
    const manualPhase = buildStrategyAdherence(base({ plan: phasedPlan, currentLap: 19 }));
    expect(manualPhase.fuel.basis).toBe("unknown");
    expect(manualPhase.fuel.plannedRate).toBeNull();
    expect(manualPhase.tires.every((tire) => tire.basis === "unknown" && tire.plannedRate === null)).toBe(true);
  });
  test("Float32 tire-rate noise stays within budget while a real rate increase remains over", () => {
    const evidence: StintSummary = { ...summary, tires: [0, 1, 2, 3].map(() => rate(0.008, "wearFraction/lap")) as StintSummary["tires"] };
    const pinned = { ...plan, stints: plan.stints.map((stint) => ({ ...stint, evidence })) };
    for (const [observed, expected] of [[0.008000001907348633, "within"], [0.0080002, "over"]] as const) {
      const model = buildStrategyAdherence(base({ plan: pinned, currentStint: evidence,
        strategy: { ...base().strategy!, fuel: liveRate(2), tires: [0, 1, 2, 3].map(() => liveRate(observed, "wearFraction/lap")) as StintSummary["tires"] } }));
      expect(model.tires.map((tire) => tire.state)).toEqual([expected, expected, expected, expected]);
      expect(model.state).toBe(expected);
    }
  });
});
