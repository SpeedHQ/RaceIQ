/**
 * persistLapMetrics writes precomputed fuel/tyre onto the lap at save time, so
 * /lap-metrics is a pure column read for laps recorded going forward (no
 * first-open telemetry decode). Verifies derivation + that nothing is written
 * when no channel is usable.
 */
import { afterEach, describe, test, expect } from "bun:test";
import { persistLapMetrics } from "../../server/lap-analysis/metrics-store";
import { CapturingDbAdapter } from "../../server/telemetry/pipeline-ports";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { eq } from "drizzle-orm";
import { db } from "../../server/db";
import { lapMetrics, laps, sessions } from "../../server/db/schema";
import { _telemetryCacheForTest } from "../../server/db/telemetry-replay-storage";
import { initServerGameAdapters } from "../../server/games/init";
import { finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";
import {
  getOrComputeLapMetrics,
  getOrComputeLapMetricsBatch,
} from "../../server/lap-analysis/metrics-store";
import { LAP_METRICS_ALGO_VERSION } from "../../server/lap-analysis/metrics";
import { qualityPackets, summarize } from "../support/lap-analysis/quality-model";


function mkPackets(opts: { fuelPerLap?: number; tyreWear?: number[]; fuel?: [number, number] }): TelemetryPacket[] {
  const base = (i: number) => ({ DistanceTraveled: i * 5, Speed: 50 } as unknown as TelemetryPacket);
  const a = base(0);
  const b = base(1);
  if (opts.fuel) { (a as any).Fuel = opts.fuel[0]; (b as any).Fuel = opts.fuel[1]; }
  if (opts.fuelPerLap != null) (b as any).acc = { fuelPerLap: opts.fuelPerLap };
  if (opts.tyreWear) {
    const [fl, fr, rl, rr] = opts.tyreWear;
    (b as any).TireWearFL = fl; (b as any).TireWearFR = fr; (b as any).TireWearRL = rl; (b as any).TireWearRR = rr;
  }
  return [a, b];
}

describe("persistLapMetrics", () => {
  test("persists game-reported fuelPerLap + worst-tyre wear", async () => {
    const db = new CapturingDbAdapter();
    await persistLapMetrics(db, 42, mkPackets({ fuelPerLap: 2.7, tyreWear: [0.1, 0.12, 0.2, 0.18] }));
    expect(db.lapMetrics).toHaveLength(1);
    expect(db.lapMetrics[0]).toEqual({ lapId: 42, fuelPerLap: 2.7, tyreWear: 20 });
  });

  test("falls back to fuel delta when no per-lap field", async () => {
    const db = new CapturingDbAdapter();
    await persistLapMetrics(db, 7, mkPackets({ fuel: [50, 47.5] }));
    expect(db.lapMetrics[0]).toEqual({ lapId: 7, fuelPerLap: 2.5, tyreWear: null });
  });

  test("writes nothing when no channel is usable", async () => {
    const db = new CapturingDbAdapter();
    await persistLapMetrics(db, 9, mkPackets({}));
    expect(db.lapMetrics).toHaveLength(0);
  });
});

initServerGameAdapters();

const qualitySessionIds: number[] = [];
const FINALIZED_SOURCE_GENERATION = `sha256:${"a".repeat(64)}`;

afterEach(async () => {
  for (const sessionId of qualitySessionIds.splice(0)) {
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  _telemetryCacheForTest.clear();
});

describe("quality-versioned lap metrics cache", () => {
  test("accepts null equality then invalidates when the lap gains a generation", async () => {
    const packets = qualityPackets(100);
    const generated = finalizeLapQualityGeneration(
      summarize(packets),
      FINALIZED_SOURCE_GENERATION,
      {
        lapNumber: 1,
        rawByteOffset: 1_000,
        rawFrameCount: packets.length,
      },
    );
    const sessionId = (
      await db
        .insert(sessions)
        .values({ carOrdinal: 301, trackOrdinal: 401, gameId: "f1-2025" })
        .returning({ id: sessions.id })
        .get()
    ).id;
    qualitySessionIds.push(sessionId);
    const lapId = (
      await db
        .insert(laps)
        .values({
          sessionId,
          lapNumber: 1,
          lapTime: 100,
          rawByteOffset: 1_000,
          rawFrameCount: packets.length,
          quality: generated.quality,
          eligibility: generated.eligibility,
          qualitySchemaVersion: generated.quality.provenance.schemaVersion,
          qualityPolicyVersion: generated.quality.provenance.policyVersion,
          qualityConfigVersion: generated.quality.provenance.configurationVersion,
          qualityGeneration: null,
        })
        .returning({ id: laps.id })
        .get()
    ).id;
    _telemetryCacheForTest.set(lapId, packets);
    await db.insert(lapMetrics).values({
      lapId,
      algoVersion: LAP_METRICS_ALGO_VERSION,
      qualityGeneration: null,
      insights: "[]",
      segmentStats: "[]",
      computedAt: "legacy-null",
    });

    const legacyHit = await getOrComputeLapMetrics(lapId);
    expect(legacyHit?.computedAt).toBe("legacy-null");

    await db
      .update(laps)
      .set({ qualityGeneration: generated.quality.provenance.outputGeneration })
      .where(eq(laps.id, lapId))
      .run();
    const metrics = await getOrComputeLapMetrics(lapId);

    expect(metrics?.computedAt).not.toBe("legacy-null");
    const stored = await db
      .select({
        qualityGeneration: lapMetrics.qualityGeneration,
        computedAt: lapMetrics.computedAt,
      })
      .from(lapMetrics)
      .where(eq(lapMetrics.lapId, lapId))
      .get();
    expect(stored).toEqual({
      qualityGeneration: generated.quality.provenance.outputGeneration,
      computedAt: metrics!.computedAt,
    });
  });

  test("batch keeps only matching generations and recomputes stale and null rows", async () => {
    const packets = qualityPackets(100);
    const generatedByLap = [1, 2, 3].map((lapNumber) =>
      finalizeLapQualityGeneration(
        summarize(packets),
        FINALIZED_SOURCE_GENERATION,
        {
          lapNumber,
          rawByteOffset: lapNumber * 1_000,
          rawFrameCount: packets.length,
        },
      ),
    );
    const sessionId = (
      await db
        .insert(sessions)
        .values({ carOrdinal: 302, trackOrdinal: 402, gameId: "f1-2025" })
        .returning({ id: sessions.id })
        .get()
    ).id;
    qualitySessionIds.push(sessionId);
    const insertedLaps = await db
      .insert(laps)
      .values(
        generatedByLap.map((generated, index) => ({
          sessionId,
          lapNumber: index + 1,
          lapTime: 100 + index,
          rawByteOffset: (index + 1) * 1_000,
          rawFrameCount: packets.length,
          quality: generated.quality,
          eligibility: generated.eligibility,
          qualitySchemaVersion: generated.quality.provenance.schemaVersion,
          qualityPolicyVersion: generated.quality.provenance.policyVersion,
          qualityConfigVersion: generated.quality.provenance.configurationVersion,
          qualityGeneration: generated.quality.provenance.outputGeneration,
        })),
      )
      .returning({ id: laps.id, qualityGeneration: laps.qualityGeneration })
      .all();
    const [staleLap, nullLap, currentLap] = insertedLaps;
    for (const lap of insertedLaps) {
      _telemetryCacheForTest.set(lap.id, packets);
    }
    await db.insert(lapMetrics).values([
      {
        lapId: staleLap!.id,
        algoVersion: LAP_METRICS_ALGO_VERSION,
        qualityGeneration: "sha256:stale-quality",
        insights: "[]",
        segmentStats: "[]",
        computedAt: "stale",
      },
      {
        lapId: nullLap!.id,
        algoVersion: LAP_METRICS_ALGO_VERSION,
        qualityGeneration: null,
        insights: "[]",
        segmentStats: "[]",
        computedAt: "legacy-null",
      },
      {
        lapId: currentLap!.id,
        algoVersion: LAP_METRICS_ALGO_VERSION,
        qualityGeneration: currentLap!.qualityGeneration,
        insights: "[]",
        segmentStats: "[]",
        computedAt: "cached-current",
      },
    ]);

    const metrics = await getOrComputeLapMetricsBatch(
      insertedLaps.map(({ id }) => id),
    );

    expect(metrics.get(staleLap!.id)?.computedAt).not.toBe("stale");
    expect(metrics.get(nullLap!.id)?.computedAt).not.toBe("legacy-null");
    expect(metrics.get(currentLap!.id)?.computedAt).toBe("cached-current");
    const stored = await db
      .select({
        lapId: lapMetrics.lapId,
        qualityGeneration: lapMetrics.qualityGeneration,
      })
      .from(lapMetrics)
      .where(eq(lapMetrics.lapId, staleLap!.id))
      .get();
    expect(stored).toEqual({
      lapId: staleLap!.id,
      qualityGeneration: staleLap!.qualityGeneration,
    });
    const storedNull = await db
      .select({
        lapId: lapMetrics.lapId,
        qualityGeneration: lapMetrics.qualityGeneration,
      })
      .from(lapMetrics)
      .where(eq(lapMetrics.lapId, nullLap!.id))
      .get();
    expect(storedNull).toEqual({
      lapId: nullLap!.id,
      qualityGeneration: nullLap!.qualityGeneration,
    });
  });
});
