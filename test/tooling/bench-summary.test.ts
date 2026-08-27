import { describe, expect, test } from "bun:test";
import { formatMitataSummary } from "../../scripts/quality/bench-summary";

describe("Mitata benchmark summary", () => {
  test("surfaces every benchmark metric with units and context", () => {
    const output = formatMitataSummary({
      context: { runtime: "bun", arch: "arm64", cpu: { name: "M5", freq: 4000 } },
      benchmarks: [{
        alias: "fm/pipeline",
        runs: [{
          stats: {
            min: 1_000, max: 3_000, avg: 2_000, p25: 1_500, p50: 2_000,
            p75: 2_500, p99: 2_900, p999: 2_990, samples: [1_000], ticks: 1,
            kind: "fn", debug: "pipeline", counters: { ops: 42 },
            gc: { min: 1, p50: 2, max: 3, avg: 2, total: 4 },
          },
        }],
      }],
    });

    expect(output).toContain("fm/pipeline");
    expect(output).toContain("2.00 µs");
    expect(output).toContain("p99");
    expect(output).toContain("gc.total");
    expect(output).toContain("counters.ops");
    expect(output).toContain("Runtime: `bun`");
  });

  test("rejects missing benchmark metrics explicitly", () => {
    expect(() => formatMitataSummary({ context: {}, benchmarks: [] })).toThrow(/no benchmark metrics/i);
  });
});
