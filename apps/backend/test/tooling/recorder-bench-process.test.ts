import { describe, expect, test } from "bun:test";
import { parseProcessRows, ProcessTreeSampler } from "../benchmarks/recorder-bench-process";

describe("recorder process resources", () => {
  test("preserves CPU seconds and RSS across macOS and Linux ps formats", () => {
    const rows = parseProcessRows([
      "  101 1 12:34.56 102400",
      "  102 101 01:02:03 204800",
      "  103 101 2-03:04:05 409600",
      "  104 1 123:45.67 512",
    ].join("\n"));

    expect(rows.get(101)).toEqual({ parent: 1, cpuSeconds: 754.56, rssBytes: 104857600 });
    expect(rows.get(102)).toEqual({ parent: 101, cpuSeconds: 3723, rssBytes: 209715200 });
    expect(rows.get(103)).toEqual({ parent: 101, cpuSeconds: 183845, rssBytes: 419430400 });
    expect(rows.get(104)).toEqual({ parent: 1, cpuSeconds: 7425.67, rssBytes: 524288 });
  });

  test("rejects unavailable initial root samples instead of reporting zero resources", async () => {
    const sampler = new ProcessTreeSampler(-1, true);
    await expect(sampler.mark()).rejects.toThrow("No process resource sample for root PID -1");
  });
});
