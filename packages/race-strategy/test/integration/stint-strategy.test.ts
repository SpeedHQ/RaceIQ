import { afterEach, describe, expect, test } from "bun:test";
import { initStrategyTestAdapters } from "../support/init";
import { parseForzaPacket } from "@raceiq/game-fm-2023/parser";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { PitEstimateRecord, StintSummary } from "@raceiq/shared/racing/live/strategy";
import { StintSummarySchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { aggregateLapMetrics, STRATEGY_ALGORITHM_VERSION } from "@raceiq/race-strategy/server";
import { StintMetricAccumulator } from "@raceiq/race-strategy/server";
import { strategyContext, StrategyBoundary, StrategyBoundaryTracker } from "@raceiq/race-strategy/server";
import { DurableStrategyTracker } from "@raceiq/race-strategy/server";
import { PitTracker } from "@raceiq/race-strategy/server";
import { getStrategyBaseline } from "@raceiq/race-strategy/server";
import { activateStrategyRebuild, admitStrategyObservation, clearPitEstimates, closeStrategyStint, getPitEstimatePage, getStrategyHistoryRevision, getStrategyStints, interruptActiveStrategyStints, persistStrategyLapMetrics, savePitEstimate, saveStrategyStint, StaleStrategyIdentityError } from "@raceiq/race-strategy/server";
import { insertSession, deleteSession, deleteEmptySessions, updateSessionCarTrack } from "@raceiq/backend-core/db/session-queries";
import { client, db } from "@raceiq/backend-core/db/index";
import { laps } from "@raceiq/backend-core/db/schema";
import { generateRacePlanStints } from "../../contracts/generate-race-plan";

initStrategyTestAdapters();
const ownedSessions: number[] = [];
afterEach(async () => {
  await client.execute("DROP TRIGGER IF EXISTS strategy_contract_fail");
  for (const id of ownedSessions.splice(0)) await deleteSession(id);
});
function packet(fuel: number, wear = 0.1, timestamp = 1_000, lapNumber = 1): TelemetryPacket {
  const data = Buffer.alloc(331);
  data.writeInt32LE(1, 0); data.writeUInt32LE(timestamp, 4);
  data.writeInt32LE(642, 212); data.writeInt32LE(800, 220); data.writeInt32LE(5, 327);
  data.writeFloatLE(fuel, 276); data.writeFloatLE(timestamp / 10, 280);
  data.writeFloatLE(timestamp / 1_000, 292); data.writeFloatLE(timestamp / 1_000, 296);
  data.writeUInt16LE(lapNumber, 300);
  for (const offset of [311, 315, 319, 323]) data.writeFloatLE(wear, offset);
  return parseForzaPacket(data)!;
}
async function session(): Promise<number> {
  const id = await insertSession("642", "5", "fm-2023", undefined, undefined, "mine");
  ownedSessions.push(id); return id;
}
function accumulator(id: number, ordinal: number, driverKey = "contract-driver"): StintMetricAccumulator {
  return new StintMetricAccumulator({ ...strategyContext(packet(0.8)), id: `stint-${id}-${driverKey}-${ordinal}`, sessionId: id, driverKey, ordinal, startedAt: "2025-01-01T00:00:00.000Z" });
}
async function savedLap(sessionId: number, lapNumber: number): Promise<number> {
  const row = await db.insert(laps).values({ sessionId, lapNumber, lapTime: 60, isValid: true }).returning({ id: laps.id }).get();
  return row.id;
}
function metric(fuel = 0.02, wear = 0.008) {
  return aggregateLapMetrics([packet(0.8), packet(0.8 - fuel, 0.1 + wear, 2_000)], { valid: true, lapTimeSeconds: 60, fuelUnit: "tankFraction", allowContinuousWear: true });
}
async function completed(id: number, ordinal: number, count: number, fuel: number, driverKey = "contract-driver") {
  const acc = accumulator(id, ordinal, driverKey);
  for (let index = 0; index < count; index++) {
    const lapId = await savedLap(id, ordinal * 100 + index);
    const contribution = metric(fuel);
    const summary = acc.add(ordinal * 100 + index, contribution);
    await persistStrategyLapMetrics({ sessionId: id, driverKey, lapId, stintId: summary.id, algorithmVersion: STRATEGY_ALGORITHM_VERSION, contribution }, summary, acc.totals());
  }
  await closeStrategyStint(acc.close("pit-visit", "observed", new Date(Date.UTC(2025, 0, 1, 0, 0, ordinal)).toISOString()));
  return acc;
}
function record(summary: StintSummary, sourceOrder: { epochOrdinal: number; sequence: number }): PitEstimateRecord {
  return { id: `estimate-${summary.id}-${sourceOrder.epochOrdinal}-${sourceOrder.sequence}`, sessionId: summary.sessionId, driverKey: summary.driverKey, stintId: summary.id,
    gameId: summary.gameId, trackId: summary.trackId, carId: summary.carId, pi: summary.pi, compounds: summary.compounds,
    observedAt: "2025-01-01T00:00:00.000Z", sourceOrder, sourceCoordinate: { epoch: "native", domain: "session", milliseconds: 0 }, trigger: "lap-completed",
    pitInLaps: 4, estimatedPitTime: { sessionElapsedSeconds: 300 }, limitedBy: "fuel", tyreChangeSuggestion: "not-indicated", fuelChangeSuggestion: "consider-refuel",
    fuel: summary.fuel, tires: summary.tires, sourceSnapshot: { fuelRemaining: 0.4, fuelUnit: "tankFraction", wear: [0.1, 0.1, 0.1, 0.1], lapId: null },
    compatibility: summary.compatibility, baseline: null, algorithmVersion: STRATEGY_ALGORITHM_VERSION };
}

describe("durable stint strategy contract", () => {
  test("full-stint statistics retain zero and excluded-wheel evidence beyond rolling windows", async () => {
    const id = await session();
    const acc = accumulator(id, 1);
    expect(acc.snapshot().rateStatistics?.fuel).toEqual({ median: null, peak: null });
    for (const [index, value] of [0.09, 0, 0.02, 0.01, 0.08, 0.03, 0.04].entries()) {
      const contribution = { ...metric(), fuelUsed: value, tireWear: [value, index === 0 ? null : value, 0, null] as [number, number | null, number, null] };
      const summary = acc.add(index + 1, contribution);
      const lapId = await savedLap(id, index + 1);
      await persistStrategyLapMetrics({ sessionId: id, driverKey: summary.driverKey, lapId, stintId: summary.id, algorithmVersion: STRATEGY_ALGORITHM_VERSION, contribution }, summary, acc.totals());
      if (index === 0) expect(summary.rateStatistics?.fuel).toEqual({ median: 0.09, peak: 0.09 });
    }
    const stored = (await getStrategyStints(id))[0]!;
    expect(stored.fuel.value).toBeCloseTo(0.27 / 7);
    expect(stored.rateStatistics?.fuel).toEqual({ median: 0.03, peak: 0.09 });
    expect(stored.rateStatistics?.tires).toEqual([
      { median: 0.03, peak: 0.09 }, { median: 0.025, peak: 0.08 },
      { median: 0, peak: 0 }, { median: null, peak: null },
    ]);
    expect(stored.tires.map((rate) => rate.eligibleLaps)).toEqual([7, 6, 7, 0]);
    expect(acc.rollingRates().fuel.value).toBeCloseTo(0.18 / 5);
    expect(acc.rollingRates().tires[0].value).toBeCloseTo(0.15 / 3);
    const legacy = { ...stored };
    delete legacy.rateStatistics;
    expect(StintSummarySchema.parse(legacy).fuel.value).toBe(stored.fuel.value);
    expect(StintSummarySchema.parse(legacy).rateStatistics).toBeUndefined();
  });
  test("staged statistic populations are isolated when a fork is rejected", () => {
    const acc = accumulator(1, 1);
    acc.add(1, { ...metric(), fuelUsed: 0, tireWear: [0, 0, 0, 0] });
    const staged = acc.fork();
    staged.add(2, { ...metric(), fuelUsed: 0.08, tireWear: [0.08, null, 0.08, null] });
    expect(staged.snapshot().rateStatistics?.fuel).toEqual({ median: 0.04, peak: 0.08 });
    expect(acc.snapshot().rateStatistics?.fuel).toEqual({ median: 0, peak: 0 });
    acc.add(2, { ...metric(), fuelUsed: 0.02, tireWear: [0.02, 0.02, 0.02, 0.02] });
    expect(acc.snapshot().rateStatistics?.fuel).toEqual({ median: 0.01, peak: 0.02 });
    expect(staged.snapshot().rateStatistics?.tires[0]).toEqual({ median: 0.04, peak: 0.08 });
  });
  test("generated strategies respect exact fuel boundaries, tire limits and missing evidence", () => {
    const acc = accumulator(1, 1);
    acc.add(1, metric());
    const source = acc.close("pit-visit", "observed", "2025-01-01T00:01:00.000Z");
    source.compounds = ["default", "default", "default", "default"];
    source.fuel.value = 0.02;
    const thresholds = () => ({ cliffPct: 80, deadPct: 20 });
    const fuelLimited = generateRacePlanStints(source, 12, 0.115, 0.01, thresholds)!;
    expect(fuelLimited.map((stint) => stint.endLap)).toEqual([5, 10, 12]);
    expect(fuelLimited.map((stint) => stint.sourceStintId)).toEqual([source.id, source.id, source.id]);
    expect(generateRacePlanStints(source, 3, 0.03, 0.01, thresholds)?.map((stint) => stint.endLap)).toEqual([1, 2, 3]);
    expect(generateRacePlanStints(source, 6, 1, 0, () => ({ cliffPct: 98, deadPct: 20 }))?.map((stint) => stint.endLap)).toEqual([2, 4, 6]);
    expect(generateRacePlanStints(source, 101, 0.03, 0.01, thresholds)).toBeNull();
    expect(generateRacePlanStints(source, 12, 0.01, 0.01, thresholds)).toBeNull();
    expect(generateRacePlanStints(source, 12, 1.1, 0, thresholds)).toBeNull();
    const missing = { ...source, tires: source.tires.map((tire) => ({ ...tire, value: null })) as StintSummary["tires"] };
    expect(generateRacePlanStints(missing, 12, 1, 0, thresholds)).toBeNull();
    const zero = { ...source, fuel: { ...source.fuel, value: 0 }, tires: source.tires.map((tire) => ({ ...tire, value: 0 })) as StintSummary["tires"] };
    expect(generateRacePlanStints(zero, 12, 1, 0.1, thresholds)?.map((stint) => ({ end: stint.endLap, fuel: stint.startFuel }))).toEqual([{ end: 12, fuel: 0.1 }]);
  });
  test("C2/C6 zero, missing wheels, resets and fuel coverage stay independent", () => {
    const start = packet(0.8);
    const middle = packet(0.79, 0.104, 1_500);
    const end = packet(0.78, 0.108, 2_000);
    middle.TireWearFR = -1;
    const contribution = aggregateLapMetrics([start, middle, end], { valid: true, lapTimeSeconds: 60, fuelUnit: "tankFraction", allowContinuousWear: true });
    expect(contribution.fuelUsed).toBeCloseTo(0.02, 6);
    expect(contribution.tireWear[0]).toBeCloseTo(0.008, 6);
    expect(contribution.tireWear[1]).toBeNull();
    expect(metric(0, 0).fuelUsed).toBe(0);
    expect(metric(0, 0).tireWear).toEqual([0, 0, 0, 0]);
    const refilled = aggregateLapMetrics([packet(0.8), packet(0.9, 0.104, 1_500), packet(0.89, 0.108, 2_000)], { valid: true, lapTimeSeconds: 60, fuelUnit: "tankFraction", allowContinuousWear: true });
    expect(refilled.fuelUsed).toBeNull();
    expect(refilled.measuredFuelUsed).toBeCloseTo(0.01, 6);
    expect(refilled.fuelCoverage).toBe("partial");
    const invalid = aggregateLapMetrics([start, end], { valid: false, lapTimeSeconds: 60, fuelUnit: "tankFraction", allowContinuousWear: false });
    expect(invalid.lapTimeSeconds).toBeNull();
    expect(invalid.measuredFuelUsed).toBeCloseTo(0.02, 6);
    expect(invalid.tireWear).toEqual([null, null, null, null]);
  });
  test("LMU lap-distance corrections retain rates while timestamp gaps remain excluded", () => {
    const start = { ...packet(0.8), gameId: "lmu" as const, DistanceTraveled: 16007.048 };
    const end = { ...packet(0.78, 0.108, 2_000), gameId: "lmu" as const, DistanceTraveled: 16004.037 };
    const options = { valid: true, lapTimeSeconds: 60, fuelUnit: "tankFraction" as const, allowContinuousWear: true };
    const measured = aggregateLapMetrics([start, end], options);
    expect(measured.fuelUsed).toBeCloseTo(0.02, 6);
    expect(measured.tireWear[0]).toBeCloseTo(0.008, 6);
    expect(measured.lapTimeSeconds).toBe(60);
    const gap = aggregateLapMetrics([start, { ...end, TimestampMS: 7_000 }], options);
    expect(gap.exclusionReason).toBe("discontinuous-lap");
    expect(gap.fuelUsed).toBeNull();
    expect(gap.tireWear).toEqual([null, null, null, null]);
  });
  test("E1 measures native LMU energy independently, excludes missing/reset/gapped intervals", () => {
    const lmuPacket = (fuel: number, energy: number | undefined, timestamp: number): TelemetryPacket => ({
      ...packet(fuel, 0.1, timestamp), gameId: "lmu", lmu: energy === undefined ? {} as NonNullable<TelemetryPacket["lmu"]> : { virtualEnergy: energy } as NonNullable<TelemetryPacket["lmu"]>,
    });
    const options = { valid: true, lapTimeSeconds: 60, fuelUnit: "tankFraction" as const, allowContinuousWear: true };
    const measured = aggregateLapMetrics([lmuPacket(0.8, 0.9, 1_000), lmuPacket(0.79, 0.8, 2_000)], options);
    expect(measured.fuelUsed).toBeCloseTo(0.01, 6);
    expect(measured.virtualEnergyUsed).toBeCloseTo(0.1, 6);
    expect(aggregateLapMetrics([lmuPacket(0.8, 0.9, 1_000), lmuPacket(0.79, undefined, 1_500), lmuPacket(0.78, 0.7, 2_000)], options).virtualEnergyUsed).toBeNull();
    const reset = aggregateLapMetrics([lmuPacket(0.8, 0.8, 1_000), lmuPacket(0.79, 0.9, 1_500)], options);
    expect(reset.virtualEnergyUsed).toBeNull();
    expect(reset.virtualEnergyExcludedReason).toBe("virtual-energy-reset-or-refill");
    const zero = aggregateLapMetrics([lmuPacket(0.8, 0.7, 1_000), lmuPacket(0.79, 0.7, 2_000)], options);
    expect(zero.virtualEnergyUsed).toBe(0);
    const gap = aggregateLapMetrics([lmuPacket(0.8, 0.9, 1_000), lmuPacket(0.79, 0.8, 7_000)], options);
    expect(gap.virtualEnergyUsed).toBeNull();
    expect(gap.fuelUsed).toBeNull();
  });
  test("E1 accumulation and forks preserve independent energy totals and energy refill is not fuel", () => {
    const lmuPacket = (fuel: number, energy: number, timestamp: number): TelemetryPacket => ({
      ...packet(fuel, 0.1, timestamp), gameId: "lmu", lmu: { virtualEnergy: energy } as NonNullable<TelemetryPacket["lmu"]>,
    });
    const options = { valid: true, lapTimeSeconds: 60, fuelUnit: "tankFraction" as const, allowContinuousWear: true };
    const contribution = aggregateLapMetrics([lmuPacket(0.8, 0.9, 1_000), lmuPacket(0.78, 0.8, 2_000)], options);
    const acc = accumulator(2, 1);
    const first = acc.add(1, contribution);
    expect(first.virtualEnergy).toMatchObject({ eligibleLaps: 1, unit: "energyFraction/lap" });
    expect(first.virtualEnergy?.value).toBeCloseTo(0.1, 6);
    expect(first.fuel.value).toBeCloseTo(0.02, 6);
    const fork = acc.fork();
    const next = fork.add(2, aggregateLapMetrics([lmuPacket(0.78, 0.8, 3_000), lmuPacket(0.77, 0.6, 4_000)], options));
    expect(next.virtualEnergy?.value).toBeCloseTo(0.15, 6);
    expect(next.fuel.value).toBeCloseTo(0.015, 6);
    expect(acc.snapshot().virtualEnergy?.value).toBeCloseTo(0.1, 6);
    expect(strategyContext(lmuPacket(0.8, 0.9, 1_000)).compatibility.virtualEnergySemanticVersion).toContain("virtual-energy-remaining-fraction-v1");
  });
  test("LMU energy refills coalesce as energy boundaries without false fuel boundaries", () => {
    const make = (fuel: number, energy: number, timestamp: number): TelemetryPacket => ({
      ...packet(fuel, 0.1, timestamp), gameId: "lmu", lmu: { virtualEnergy: energy } as NonNullable<TelemetryPacket["lmu"]>,
    });
    const tracker = new StrategyBoundaryTracker();
    const first = make(0.8, 0.7, 1_000);
    const refill = make(0.8, 0.8, 1_100);
    const continued = make(0.8, 0.9, 1_200);
    expect(tracker.observe(first, refill) & StrategyBoundary.Energy).toBe(StrategyBoundary.Energy);
    expect(tracker.observe(refill, continued) & StrategyBoundary.Energy).toBe(0);
    expect(tracker.observe(continued, make(0.79, 0.89, 1_300)) & StrategyBoundary.Energy).toBe(0);
    expect(strategyContext(first).compatibility.virtualEnergySemanticVersion).not.toBeNull();
    expect(strategyContext(packet(0.8)).compatibility.virtualEnergySemanticVersion).toBeNull();
  });
  test("LMU energy respects lap exclusions while measured fuel intervals remain available", () => {
    const make = (fuel: number, energy: number, timestamp: number, inPits = false): TelemetryPacket => ({
      ...packet(fuel, 0.1, timestamp), gameId: "lmu", lmu: { virtualEnergy: energy, inPits } as NonNullable<TelemetryPacket["lmu"]>,
    });
    const options = { lapTimeSeconds: 60, fuelUnit: "tankFraction" as const, allowContinuousWear: true };
    const start = make(0.8, 0.9, 1_000);
    const end = make(0.78, 0.8, 2_000);
    const invalid = aggregateLapMetrics([start, end], { ...options, valid: false });
    expect(invalid.virtualEnergyUsed).toBeNull();
    expect(invalid.virtualEnergyExcludedReason).toBe("invalid-lap");
    expect(invalid.measuredFuelUsed).toBeCloseTo(0.02, 6);
    const service = aggregateLapMetrics([start, end], { ...options, valid: true, serviceBoundary: true });
    expect(service.virtualEnergyUsed).toBeNull();
    expect(service.virtualEnergyExcludedReason).toBe("service-boundary");
    expect(service.measuredFuelUsed).toBeCloseTo(0.02, 6);
    const pit = aggregateLapMetrics([start, make(0.79, 0.85, 1_500, true), end], { ...options, valid: true });
    expect(pit.virtualEnergyUsed).toBeNull();
    expect(pit.virtualEnergyExcludedReason).not.toBeNull();
  });
  test("C6 finish-line context closes the native interval without admitting mixed-lap samples", () => {
    const start = packet(0.8);
    const middle = packet(0.79, 0.104, 1_500);
    const finish = packet(0.78, 0.108, 2_000, 2);
    start.CurrentLap = 59;
    middle.CurrentLap = 59.5;
    finish.CurrentLap = 0;
    const options = { valid: true, lapTimeSeconds: 60, fuelUnit: "tankFraction" as const, allowContinuousWear: true };
    const completed = aggregateLapMetrics([start, middle, finish], options);
    expect(completed.fuelUsed).toBeCloseTo(0.02, 6);
    expect(completed.tireWear[0]).toBeCloseTo(0.008, 6);
    const mixed = aggregateLapMetrics([start, middle, finish, packet(0.77, 0.112, 2_500, 2)], options);
    expect(mixed.fuelUsed).toBeNull();
    expect(mixed.tireWear).toEqual([null, null, null, null]);
  });
  test("C6 measured fuel excludes both sides of a foreign identity interval", () => {
    const foreign = packet(0.9, 0.104, 1_500);
    foreign.carId = "639";
    const mixed = aggregateLapMetrics([packet(0.8), foreign, packet(0.7, 0.108, 2_000)], { valid: true, lapTimeSeconds: 60, fuelUnit: "tankFraction", allowContinuousWear: true });
    expect(mixed.fuelUsed).toBeNull();
    expect(mixed.measuredFuelUsed).toBeNull();
    expect(mixed.fuelCoverage).toBe("unavailable");
  });
  test("C7 clearing the last received source point prevents shutdown from recreating old history", async () => {
    const id = await session();
    const tracker = new DurableStrategyTracker(() => {});
    try {
      await tracker.start({ sessionId: id, gameId: "fm-2023", carId: "642", trackId: "5", carPI: 800, bestLapTime: 0 }, packet(0.8), "capture");
      tracker.observe(packet(0.8, 0.1, 2_000));
      await tracker.admitClearBoundary(id, "local-player");
      await clearPitEstimates(id, "local-player");
      await tracker.finish();
      expect((await getPitEstimatePage(id, "fm-2023", "local-player", 25)).estimates).toEqual([]);
      expect((await getStrategyStints(id))[0]?.status).toBe("completed");
    } finally { await tracker.finish(); tracker.dispose(); }
  });
  test("C4 unresolved empty car or track identities never reuse history; exact identity still does", async () => {
    const usable = await session();
    await completed(usable, 1, 3, 0.02);
    const target = accumulator(await session(), 2).snapshot();
    const expected = await getStrategyBaseline(target);
    expect(expected.fuel.value).toBeCloseTo(0.02, 6);

    for (const field of ["carId", "trackId"] as const) {
      const revision = await getStrategyHistoryRevision(target.gameId, target.driverKey);
      const unresolvedTarget = { ...target, [field]: "" };
      const baseline = await getStrategyBaseline(unresolvedTarget);
      expect(baseline.fuel.value).toBeNull();
      expect(baseline.fuel.eligibleLaps).toBe(0);
      expect(baseline.tires.map((tire) => tire.value)).toEqual([null, null, null, null]);
      expect(baseline.evidence).toEqual([]);
      expect(baseline.historyRevision).toBe(revision);

      const unresolvedSourceId = await session();
      const unresolvedSource = await completed(unresolvedSourceId, 3, 3, 0.03);
      await client.execute({ sql: `UPDATE sessions SET ${field === "carId" ? "car_id" : "track_id"} = '' WHERE id = ?`, args: [unresolvedSourceId] });
      const noSourceBaseline = await getStrategyBaseline({ ...target, id: `${unresolvedSource.snapshot().id}-target` });
      expect(noSourceBaseline.fuel.value).toBeCloseTo(0.02, 6);
      expect(noSourceBaseline.evidence.map((entry) => entry.sessionId)).not.toContain(unresolvedSourceId);
    }
  });
  test("C4 weighted history includes earlier same-session stints and filters compatibility before bounding", async () => {
    const id = await session();
    await completed(id, 1, 1, 0.01);
    await completed(id, 2, 10, 0.03);
    for (let ordinal = 3; ordinal < 213; ordinal++) {
      const source = accumulator(id, ordinal);
      const summary = source.add(ordinal * 100, metric(0.2));
      summary.compatibility.setupKey = "other-setup";
      summary.status = "completed"; summary.endedAt = new Date(Date.UTC(2025, 0, 1, 0, 0, ordinal)).toISOString();
      await saveStrategyStint(summary, source.totals());
    }
    const target = accumulator(id, 213).snapshot();
    const baseline = await getStrategyBaseline(target);
    expect(baseline.fuel.value).toBeCloseTo(0.31 / 11, 6);
    expect(baseline.fuel.eligibleLaps).toBe(11);
    expect(new Set(baseline.evidence.map((item) => item.stintId)).size).toBe(2);
    expect(baseline.limitations).toContain("unknown-setup-key");
    target.pi = null;
    expect((await getStrategyBaseline(target)).fuel.value).toBeNull();
  });
  test("C6a incompatible fuel units do not suppress compatible wheel evidence", async () => {
    const id = await session();
    const source = await completed(id, 1, 3, 0.02);
    const changed = source.snapshot();
    changed.fuelUnit = "L"; changed.fuel.unit = "L/lap";
    changed.compatibility.fuelSemanticVersion = "different-fuel-semantics";
    await saveStrategyStint(changed, source.totals());
    const target = accumulator(id, 2).snapshot();
    target.compounds[1] = "different-compound";
    const baseline = await getStrategyBaseline(target);
    expect(baseline.fuel.value).toBeNull();
    expect(baseline.tires[0].value).toBeCloseTo(0.008, 6);
    expect(baseline.tires[1].value).toBeNull();
  });
  test("C7a queued writes, empty clear, new zero-time epochs and all-driver cursors have durable boundaries", async () => {
    const id = await session();
    const a = await completed(id, 1, 1, 0.02, "driver-a");
    const b = await completed(id, 1, 1, 0.02, "driver-b");
    const first = await admitStrategyObservation(id, "epoch-a", "0");
    const second = await admitStrategyObservation(id, "epoch-a", "1");
    await savePitEstimate(record(a.snapshot(), first)); await savePitEstimate(record(b.snapshot(), second));
    const page = await getPitEstimatePage(id, "fm-2023", undefined, 1);
    expect(page.nextCursor).not.toBeNull();
    const queued = await admitStrategyObservation(id, "epoch-a", "2");
    await clearPitEstimates(id, "driver-a");
    expect(await savePitEstimate(record(a.snapshot(), queued))).toBe(false);
    await expect(getPitEstimatePage(id, "fm-2023", undefined, 1, page.nextCursor!)).rejects.toThrow();
    expect((await getPitEstimatePage(id, "fm-2023", "driver-b", 25)).estimates.map((item) => item.driverKey)).toEqual(["driver-b"]);
    await clearPitEstimates(id, "driver-a");
    const nextEpoch = await admitStrategyObservation(id, "epoch-b", "0");
    expect(nextEpoch).toEqual({ epochOrdinal: 1, sequence: 0 });
    expect(await savePitEstimate(record(a.snapshot(), nextEpoch))).toBe(true);
    expect(await admitStrategyObservation(id, "epoch-a", "0")).toEqual(first);
    expect(await savePitEstimate(record(a.snapshot(), first))).toBe(false);
  });
  test("C7b deletion and identity corrections change namespace revision while immutable estimates survive rebuild rollback", async () => {
    const id = await session();
    const source = await completed(id, 1, 1, 0.02);
    const target = accumulator(id, 2).snapshot();
    const baseline = await getStrategyBaseline(target);
    const estimate = record(source.snapshot(), await admitStrategyObservation(id, "epoch", "1"));
    await savePitEstimate(estimate);
    const lapId = await savedLap(id, 999);
    await client.execute("CREATE TRIGGER strategy_contract_fail BEFORE INSERT ON strategy_lap_metrics BEGIN SELECT RAISE(ABORT,'injected rebuild failure'); END");
    await expect(activateStrategyRebuild(id, { gameId: "fm-2023", carId: "642", trackId: "5", ownership: "mine" }, "failed", [{ summary: source.snapshot(), totals: source.totals() }], [{ sessionId: id, driverKey: "contract-driver", lapId, stintId: source.snapshot().id, algorithmVersion: STRATEGY_ALGORITHM_VERSION, contribution: metric() }])).rejects.toThrow();
    expect(await getStrategyHistoryRevision("fm-2023", "contract-driver")).toBe(baseline.historyRevision);
    expect((await getPitEstimatePage(id, "fm-2023", undefined, 25)).estimates).toEqual([estimate]);
    await client.execute("DROP TRIGGER strategy_contract_fail");
    await updateSessionCarTrack(id, "639", "5");
    expect(await getStrategyStints(id)).toEqual([]);
    expect(await getStrategyHistoryRevision("fm-2023", "contract-driver")).toBeGreaterThan(baseline.historyRevision);
    expect((await getPitEstimatePage(id, "fm-2023", undefined, 25)).estimates).toEqual([estimate]);
    await expect(saveStrategyStint(source.snapshot(), source.totals())).rejects.toBeInstanceOf(StaleStrategyIdentityError);
    await expect(closeStrategyStint(source.snapshot())).rejects.toBeInstanceOf(StaleStrategyIdentityError);
    await expect(savePitEstimate(estimate)).rejects.toBeInstanceOf(StaleStrategyIdentityError);
    expect(await getStrategyStints(id)).toEqual([]);
  });
  test("C4 live fuel takes over at two eligible current laps, independently of historical tire permissions", async () => {
    const prior = await session();
    await completed(prior, 1, 3, 0.02, "local-player");
    const current = await session();
    const tracker = new DurableStrategyTracker(() => {});
    const legacy = new PitTracker();
    try {
      await tracker.start({ sessionId: current, gameId: "fm-2023", carId: "642", trackId: "5", carPI: 800, bestLapTime: 0 }, packet(0.8), "capture");
      await tracker.flush();
      let live = tracker.apply(packet(0.8), legacy.feed(packet(0.8), 3_000)).strategy!;
      expect(live.fuel.source).toBe("history");
      expect(live.tires[0].source).toBeNull();
      for (let number = 1; number <= 2; number++) {
        const packets = [packet(0.8, 0.1, number * 3_000, number), packet(0.77, 0.108, number * 3_000 + 1_000, number)];
        tracker.prepareLap({ lapNumber: number, packets, lapDistStart: 0, lapTime: 60, isValid: true, classification: "pace", sectors: null });
        tracker.savedLap({ sessionId: current, lapId: await savedLap(current, number), lapNumber: number, lapTime: 60, isValid: true, classification: "pace", sectors: null, estimatedBestLapTime: 60 });
        await tracker.flush();
        live = tracker.apply(packets[1], legacy.feed(packets[1], 3_000)).strategy!;
        expect(live.fuel.source).toBe(number === 1 ? "history" : "current-stint");
      }
      expect(live.fuel.value).toBeCloseTo(0.03, 6);
      expect(live.fuel.eligibleLaps).toBe(2);
      await interruptActiveStrategyStints();
      expect((await getStrategyStints(current))[0]?.status).toBe("interrupted");
    } finally { await tracker.finish(); tracker.dispose(); }
  });
  test("C1 startup cleanup retains active empty stints and committed estimate-only sessions", async () => {
    const id = await session();
    const acc = accumulator(id, 1);
    await client.execute({ sql: "UPDATE sessions SET lap_detector_version='lapdetector_v7' WHERE id=?", args: [id] });
    await saveStrategyStint(acc.snapshot(), acc.totals());
    await deleteEmptySessions();
    expect((await getStrategyStints(id))[0]?.status).toBe("active");
    const observation = record(acc.snapshot(), await admitStrategyObservation(id, "epoch", "0"));
    observation.pitInLaps = null; observation.limitedBy = null;
    observation.estimatedPitTime.sessionElapsedSeconds = null;
    observation.fuelChangeSuggestion = "unavailable";
    observation.tyreChangeSuggestion = "unavailable";
    await savePitEstimate(observation);
    await interruptActiveStrategyStints();
    await deleteEmptySessions();
    expect((await getPitEstimatePage(id, "fm-2023", undefined, 25)).estimates).toEqual([observation]);
  });
});
