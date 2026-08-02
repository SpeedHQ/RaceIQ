import { describe, expect, test } from "bun:test";
import { reconcileAutoExclusions,
reconcileAutoExclusionsForLap,
type ExclusionScopeLap,
type LapExclusionWriter,
type LapExperimentScopeReader, } from "../server/experiments/auto-exclude"

/** Auto-exclude fastest-5 curation
 *  (docs/architecture/setup-engineer.md).
 *  Tests the reconciliation logic directly against a capturing in-memory
 *  writer — following the shape of test/experiment-lap-metrics.test.ts. */

const EXPERIMENT_ID = 1;
const TUNE_ID = 1;

class CapturingLapExclusionWriter implements LapExclusionWriter, LapExperimentScopeReader {
  private laps: Map<number, ExclusionScopeLap>;
  readonly writes: { lapId: number; excluded: boolean }[] = [];
  private scopes: Map<number, { experimentId: number | null; tuneId: number | null }>;

  constructor(laps: ExclusionScopeLap[], scopes?: Map<number, { experimentId: number | null; tuneId: number | null }>) {
    this.laps = new Map(laps.map((l) => [l.id, l]));
    this.scopes = scopes ?? new Map();
  }

  async getLapsForExclusionScope(_experimentId: number, _tuneId: number): Promise<ExclusionScopeLap[]> {
    return [...this.laps.values()];
  }

  async setLapAutoExclusion(lapId: number, excluded: boolean): Promise<void> {
    this.writes.push({ lapId, excluded });
    const lap = this.laps.get(lapId);
    if (lap) {
      lap.experimentExcluded = excluded;
      lap.experimentExcludedSource = "auto";
    }
  }

  async getLapExperimentScope(lapId: number): Promise<{ experimentId: number | null; tuneId: number | null }> {
    return this.scopes.get(lapId) ?? { experimentId: null, tuneId: null };
  }

  get(lapId: number): ExclusionScopeLap | undefined {
    return this.laps.get(lapId);
  }
}

/** Convenience builder for a candidate lap in its initial unreconciled state. */
function lap(
  id: number,
  lapTime: number,
  overrides: Partial<ExclusionScopeLap> = {},
): ExclusionScopeLap {
  return {
    id,
    lapTime,
    isValid: true,
    invalidReason: null,
    experimentExcluded: false,
    experimentExcludedSource: null,
    ...overrides,
  };
}

describe("reconcileAutoExclusions", () => {
  test("3 valid laps → none excluded", async () => {
    const writer = new CapturingLapExclusionWriter([lap(1, 90), lap(2, 91), lap(3, 92)]);
    await reconcileAutoExclusions(writer, EXPERIMENT_ID, TUNE_ID);
    expect(writer.get(1)?.experimentExcluded).toBe(false);
    expect(writer.get(2)?.experimentExcluded).toBe(false);
    expect(writer.get(3)?.experimentExcluded).toBe(false);
    expect(writer.get(1)?.experimentExcludedSource).toBe("auto");
    expect(writer.get(2)?.experimentExcludedSource).toBe("auto");
    expect(writer.get(3)?.experimentExcludedSource).toBe("auto");
  });

  test("8 valid laps → slowest 3 get (1, 'auto')", async () => {
    const laps = Array.from({ length: 8 }, (_, i) => lap(i + 1, 90 + i)); // 90..97, id 1 fastest
    const writer = new CapturingLapExclusionWriter(laps);
    await reconcileAutoExclusions(writer, EXPERIMENT_ID, TUNE_ID);
    for (const id of [1, 2, 3, 4, 5]) {
      expect(writer.get(id)?.experimentExcluded).toBe(false);
      expect(writer.get(id)?.experimentExcludedSource).toBe("auto");
    }
    for (const id of [6, 7, 8]) {
      expect(writer.get(id)?.experimentExcluded).toBe(true);
      expect(writer.get(id)?.experimentExcludedSource).toBe("auto");
    }
  });

  test("new fastest lap arrives → previous fifth demoted, new lap included", async () => {
    // Fastest 5 already reconciled: 90..94 kept, 95..97 excluded.
    const laps = [
      lap(1, 90, { experimentExcludedSource: "auto" }),
      lap(2, 91, { experimentExcludedSource: "auto" }),
      lap(3, 92, { experimentExcludedSource: "auto" }),
      lap(4, 93, { experimentExcludedSource: "auto" }),
      lap(5, 94, { experimentExcludedSource: "auto" }),
      lap(6, 95, { experimentExcluded: true, experimentExcludedSource: "auto" }),
      lap(7, 96, { experimentExcluded: true, experimentExcludedSource: "auto" }),
    ];
    const writer = new CapturingLapExclusionWriter(laps);
    // New lap 8 arrives, faster than the current fifth (94s).
    writer.get(1); // no-op, just ensures writer set up
    (writer as unknown as { laps: Map<number, ExclusionScopeLap> })["laps"].set(8, lap(8, 89));

    await reconcileAutoExclusions(writer, EXPERIMENT_ID, TUNE_ID);

    // New fastest 5: 89,90,91,92,93 → ids 8,1,2,3,4. Lap 5 (94s) demoted.
    for (const id of [8, 1, 2, 3, 4]) {
      expect(writer.get(id)?.experimentExcluded).toBe(false);
    }
    expect(writer.get(5)?.experimentExcluded).toBe(true);
    expect(writer.get(5)?.experimentExcludedSource).toBe("auto");
    // Untouched laps stay excluded, no redundant write.
    expect(writer.get(6)?.experimentExcluded).toBe(true);
    expect(writer.get(7)?.experimentExcluded).toBe(true);
    expect(writer.writes.some((w) => w.lapId === 6)).toBe(false);
    expect(writer.writes.some((w) => w.lapId === 7)).toBe(false);
  });

  test("invalid lap → (1, 'auto'), never occupies a slot", async () => {
    const laps = [
      lap(1, 90),
      lap(2, 91),
      lap(3, 92),
      lap(4, 999, { isValid: false, invalidReason: "off track" }),
    ];
    const writer = new CapturingLapExclusionWriter(laps);
    await reconcileAutoExclusions(writer, EXPERIMENT_ID, TUNE_ID);
    expect(writer.get(4)?.experimentExcluded).toBe(true);
    expect(writer.get(4)?.experimentExcludedSource).toBe("auto");
    // Valid laps still all included (fewer than 5 candidates).
    expect(writer.get(1)?.experimentExcluded).toBe(false);
    expect(writer.get(2)?.experimentExcluded).toBe(false);
    expect(writer.get(3)?.experimentExcluded).toBe(false);
  });

  test("pit-cycle lap → (1, 'auto')", async () => {
    const laps = [
      lap(1, 90),
      lap(2, 91),
      lap(3, 45, { invalidReason: "outlap" }), // fast time but pit-cycle, ineligible
    ];
    const writer = new CapturingLapExclusionWriter(laps);
    await reconcileAutoExclusions(writer, EXPERIMENT_ID, TUNE_ID);
    expect(writer.get(3)?.experimentExcluded).toBe(true);
    expect(writer.get(3)?.experimentExcludedSource).toBe("auto");
    expect(writer.get(1)?.experimentExcluded).toBe(false);
    expect(writer.get(2)?.experimentExcluded).toBe(false);
  });

  test("manual exclude on a top-5 lap → stays excluded, sixth-fastest promoted in", async () => {
    const laps = [
      lap(1, 90, { experimentExcluded: true, experimentExcludedSource: "manual" }), // fastest, manually excluded
      lap(2, 91),
      lap(3, 92),
      lap(4, 93),
      lap(5, 94),
      lap(6, 95), // sixth fastest overall, but fifth among non-manual candidates
    ];
    const writer = new CapturingLapExclusionWriter(laps);
    await reconcileAutoExclusions(writer, EXPERIMENT_ID, TUNE_ID);
    // Manual lap untouched.
    expect(writer.get(1)?.experimentExcluded).toBe(true);
    expect(writer.get(1)?.experimentExcludedSource).toBe("manual");
    expect(writer.writes.some((w) => w.lapId === 1)).toBe(false);
    // Remaining 5 candidates (2..6) all fit within the cap → all included.
    for (const id of [2, 3, 4, 5, 6]) {
      expect(writer.get(id)?.experimentExcluded).toBe(false);
    }
  });

  test("manual include on a slow lap → stays included, top-5 unaffected", async () => {
    const laps = [
      lap(1, 90),
      lap(2, 91),
      lap(3, 92),
      lap(4, 93),
      lap(5, 94),
      lap(6, 999, { experimentExcluded: false, experimentExcludedSource: "manual" }), // slow, manually included
    ];
    const writer = new CapturingLapExclusionWriter(laps);
    await reconcileAutoExclusions(writer, EXPERIMENT_ID, TUNE_ID);
    for (const id of [1, 2, 3, 4, 5]) {
      expect(writer.get(id)?.experimentExcluded).toBe(false);
    }
    // Manual lap never read as a candidate, never written.
    expect(writer.get(6)?.experimentExcluded).toBe(false);
    expect(writer.get(6)?.experimentExcludedSource).toBe("manual");
    expect(writer.writes.some((w) => w.lapId === 6)).toBe(false);
  });

  test("re-validated lap → reclaims a slot on the next pass", async () => {
    // First pass: lap 6 is invalid, excluded; fastest 5 are 1..5.
    const laps = [
      lap(1, 90, { experimentExcludedSource: "auto" }),
      lap(2, 91, { experimentExcludedSource: "auto" }),
      lap(3, 92, { experimentExcludedSource: "auto" }),
      lap(4, 93, { experimentExcludedSource: "auto" }),
      lap(5, 94, { experimentExcludedSource: "auto" }),
      lap(6, 89, { isValid: false, invalidReason: "off track", experimentExcluded: true, experimentExcludedSource: "auto" }),
    ];
    const writer = new CapturingLapExclusionWriter(laps);
    // Game re-validates lap 6 (fastest time of the set).
    writer.get(6)!.isValid = true;
    writer.get(6)!.invalidReason = null;

    await reconcileAutoExclusions(writer, EXPERIMENT_ID, TUNE_ID);

    // New fastest 5: 89,90,91,92,93 → ids 6,1,2,3,4. Lap 5 (94s) demoted.
    for (const id of [6, 1, 2, 3, 4]) {
      expect(writer.get(id)?.experimentExcluded).toBe(false);
    }
    expect(writer.get(5)?.experimentExcluded).toBe(true);
  });

  test("lap with null tune_id → pass skipped entirely", async () => {
    const writer = new CapturingLapExclusionWriter(
      [lap(1, 90), lap(2, 91)],
      new Map([[42, { experimentId: 1, tuneId: null }]]),
    );
    await reconcileAutoExclusionsForLap(writer, 42);
    expect(writer.writes).toHaveLength(0);
  });
});
