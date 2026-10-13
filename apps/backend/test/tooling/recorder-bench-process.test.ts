import { describe, expect, test } from "bun:test";
import { parseProcessRows, parseWindowsProcessRows, ProcessTreeSampler, readProcessOutput } from "../benchmarks/recorder-bench-process";

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

  test("converts Windows CPU ticks and working-set bytes without losing parent relationships", () => {
    const rows = parseWindowsProcessRows('\uFEFF[{"ProcessId":101,"ParentProcessId":1,"KernelModeTime":"123456789","UserModeTime":"234567890","WorkingSetSize":"104857600"},{"ProcessId":102,"ParentProcessId":101,"KernelModeTime":10000000,"UserModeTime":20000000,"WorkingSetSize":209715200}]');
    expect(rows.get(101)).toEqual({ parent: 1, cpuSeconds: 35.8024679, rssBytes: 104857600 });
    expect(rows.get(102)).toEqual({ parent: 101, cpuSeconds: 3, rssBytes: 209715200 });
  });

  test("rejects missing sampling executables promptly", async () => {
    await expect(readProcessOutput("raceiq-nonexistent-process-sampler", [])).rejects.toThrow("Process sampling failed");
  }, 2_000);

  test("rejects failed sampling commands with stderr diagnostics", async () => {
    await expect(readProcessOutput(process.execPath, ["-e", 'console.error("sampling denied"); process.exit(7)']))
      .rejects.toThrow("sampling denied");
  });

  test("samples current-process resources using the native platform command", async () => {
    const sampler = new ProcessTreeSampler(process.pid, true);
    try {
      await sampler.start();
    } finally {
      const stats = await sampler.stop();
      expect(stats.peakRssBytes).toBeGreaterThan(0);
      expect(stats.cpuSeconds).toBeGreaterThanOrEqual(0);
    }
  }, 30_000);

  test("rejects unavailable initial root samples instead of reporting zero resources", async () => {
    const sampler = new ProcessTreeSampler(-1, true);
    await expect(sampler.mark()).rejects.toThrow("No process resource sample for root PID -1");
  });
});
