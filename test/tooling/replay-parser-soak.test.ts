import { describe, expect, test } from "bun:test";
import {
  analyzeSoakResult,
  leastSquaresSlope,
  median,
  retentionBudgetFailures,
  type ReplayParserSoakMeasurement,
  type ReplayParserSoakScenarioName,
} from "../benchmarks/replay-parser-soak";

const MIB = 1024 * 1024;
const SAMPLE_COUNT = 100;

function makeMeasurement(
  heapValues: readonly number[],
  rssValues: readonly number[],
  name: ReplayParserSoakScenarioName = "parser",
): ReplayParserSoakMeasurement {
  if (heapValues.length !== rssValues.length) throw new Error("Sample series lengths must match");
  return {
    name,
    fixture: "test/fixture.bin.gz",
    framesPerIteration: 20_000,
    semanticCount: name === "replay" ? 8 : 0,
    warmupIterations: 10,
    measuredIterations: heapValues.length,
    durationMs: 1_000,
    samples: heapValues.map((postGcHeapBytes, index) => ({
      iteration: index + 1,
      postGcHeapBytes,
      postGcRssBytes: rssValues[index]!,
    })),
  };
}

function constantSamples(value: number): number[] {
  return Array.from({ length: SAMPLE_COUNT }, () => value);
}

async function runCli(argument: string): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn([process.execPath, "test/benchmarks/replay-parser-soak.ts", argument], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, output: `${stdout}\n${stderr}` };
}

describe("replay/parser soak retention analysis", () => {
  test("computes deterministic medians and least-squares slopes", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(leastSquaresSlope([10, 13, 16, 19])).toBe(3);
  });

  test("passes stable noisy post-GC samples", () => {
    const heap = Array.from(
      { length: SAMPLE_COUNT },
      (_, index) => 32 * MIB + ((index % 5) - 2) * 64 * 1024,
    );
    const rss = Array.from(
      { length: SAMPLE_COUNT },
      (_, index) => 256 * MIB + ((index % 7) - 3) * 128 * 1024,
    );

    expect(retentionBudgetFailures([analyzeSoakResult(makeMeasurement(heap, rss))])).toEqual([]);
  });

  test("passes bounded warm-up growth followed by a plateau", () => {
    const heap = Array.from(
      { length: SAMPLE_COUNT },
      (_, index) => 32 * MIB + Math.min(index * 4 * MIB, 32 * MIB),
    );
    const rss = Array.from(
      { length: SAMPLE_COUNT },
      (_, index) => 256 * MIB + Math.min(index * 8 * MIB, 64 * MIB),
    );

    expect(retentionBudgetFailures([analyzeSoakResult(makeMeasurement(heap, rss))])).toEqual([]);
  });

  test("fails sustained heap growth above both limits", () => {
    const heap = Array.from({ length: SAMPLE_COUNT }, (_, index) => 32 * MIB + index * MIB);
    const result = analyzeSoakResult(makeMeasurement(heap, constantSamples(256 * MIB)));

    expect(retentionBudgetFailures([result])).toEqual([
      "parser post-GC heap retained growth 90.0 MiB (limit 64.0 MiB) and slope " +
      "1.0 MiB/iteration (limit 0.5 MiB/iteration)",
    ]);
  });

  test("fails sustained RSS growth above both limits", () => {
    const rss = Array.from({ length: SAMPLE_COUNT }, (_, index) => 256 * MIB + index * 2 * MIB);
    const result = analyzeSoakResult(makeMeasurement(constantSamples(32 * MIB), rss, "replay"));

    expect(retentionBudgetFailures([result])).toEqual([
      "replay post-GC RSS retained growth 180.0 MiB (limit 128.0 MiB) and slope " +
      "2.0 MiB/iteration (limit 1.0 MiB/iteration)",
    ]);
  });

  test("passes when only growth or only slope exceeds its heap limit", () => {
    const growthOnly = constantSamples(32 * MIB);
    growthOnly.splice(90, 10, ...constantSamples(112 * MIB).slice(0, 10));
    const slopeOnly = Array.from(
      { length: SAMPLE_COUNT },
      (_, index) => 32 * MIB + index * 0.6 * MIB,
    );

    const growthOnlyResult = analyzeSoakResult(
      makeMeasurement(growthOnly, constantSamples(256 * MIB)),
    );
    expect(growthOnlyResult.retainedHeapGrowthBytes).toBeGreaterThan(
      growthOnlyResult.budget.maxRetainedHeapGrowthBytes,
    );
    expect(growthOnlyResult.heapSlopeBytesPerIteration).toBeLessThan(
      growthOnlyResult.budget.maxHeapSlopeBytesPerIteration,
    );
    expect(retentionBudgetFailures([growthOnlyResult])).toEqual([]);

    const slopeOnlyResult = analyzeSoakResult(
      makeMeasurement(slopeOnly, constantSamples(256 * MIB)),
    );
    expect(slopeOnlyResult.retainedHeapGrowthBytes).toBeLessThan(
      slopeOnlyResult.budget.maxRetainedHeapGrowthBytes,
    );
    expect(slopeOnlyResult.heapSlopeBytesPerIteration).toBeGreaterThan(
      slopeOnlyResult.budget.maxHeapSlopeBytesPerIteration,
    );
    expect(retentionBudgetFailures([slopeOnlyResult])).toEqual([]);
  });

  test("rejects invalid measured and warm-up iteration arguments before workers start", async () => {
    for (const argument of [
      "--iterations=19",
      "--iterations=1001",
      "--iterations=20.5",
      "--iterations=invalid",
      "--warmup=0",
      "--warmup=101",
      "--warmup=1.5",
      "--warmup=invalid",
    ]) {
      const result = await runCli(argument);
      expect(result.code, `${argument}\n${result.output}`).not.toBe(0);
      expect(result.output).toContain(`${argument.split("=")[0]} must be an integer`);
    }
  });
});
