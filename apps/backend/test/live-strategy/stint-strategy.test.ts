import { afterEach, describe, expect, test } from "bun:test";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { parseForzaPacket } from "@raceiq/game-fm-2023/parser";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { PitEstimateRecord, StintSummary } from "@raceiq/shared/racing/live/strategy";
import { aggregateLapMetrics, STRATEGY_ALGORITHM_VERSION } from "@raceiq/backend-core/live-strategy/lap-metrics";
import { StintMetricAccumulator } from "@raceiq/backend-core/live-strategy/stint-accumulator";
import { strategyContext } from "@raceiq/backend-core/live-strategy/strategy-context";
import { DurableStrategyTracker } from "@raceiq/backend-core/live-strategy/durable-strategy";
import { PitTracker } from "@raceiq/backend-core/live-strategy/pit-tracker";
import { getStrategyBaseline } from "@raceiq/backend-core/db/strategy-baseline-queries";
import { activateStrategyRebuild, admitStrategyObservation, clearPitEstimates, closeStrategyStint, getPitEstimatePage, getStrategyHistoryRevision, getStrategyStints, interruptActiveStrategyStints, persistStrategyLapMetrics, savePitEstimate, saveStrategyStint, StaleStrategyIdentityError } from "@raceiq/backend-core/db/strategy-queries";
import { insertSession, deleteSession, deleteEmptySessions, updateSessionCarTrack } from "@raceiq/backend-core/db/session-queries";
import { client, db } from "@raceiq/backend-core/db/index";
import { laps } from "@raceiq/backend-core/db/schema";

initGameAdapters();
initServerGameAdapters();
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
        tracker.prepareLap({ packets, lapDistStart: 0, lapTime: 60, isValid: true, sectors: null });
        tracker.savedLap({ sessionId: current, lapId: await savedLap(current, number), lapNumber: number, lapTime: 60, isValid: true, sectors: null, estimatedBestLapTime: 60 });
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
