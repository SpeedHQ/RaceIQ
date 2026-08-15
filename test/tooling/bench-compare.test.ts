import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

interface ReportOptions {
  readonly median?: number;
  readonly p99?: number;
  readonly heap?: number;
  readonly includeReplay?: boolean;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-bench-compare-"));
  tempDirs.push(dir);
  return dir;
}

function makeReport(options: ReportOptions = {}): string {
  const benchmarks =
    options.includeReplay === false
      ? []
      : [
          {
            alias: "resolve 20,000 canonical envelopes",
            group: 0,
            runs: [
              {
                stats: {
                  p50: options.median ?? 100,
                  p99: options.p99 ?? 120,
                  heap: { avg: options.heap ?? 1_024 },
                },
              },
            ],
          },
        ];
  return JSON.stringify({
    layout: [{ name: "replay" }],
    context: { runtime: "bun", cpu: { name: "Test CPU" } },
    benchmarks,
  });
}

async function runComparator(baseline: string, current: string, failOnRegression = false): Promise<{ code: number; output: string }> {
  const dir = makeTempDir();
  const baselinePath = join(dir, "baseline.json");
  const currentPath = join(dir, "current.json");
  await Promise.all([Bun.write(baselinePath, baseline), Bun.write(currentPath, current)]);

  const args = [process.execPath, "scripts/quality/bench-compare.ts", baselinePath, currentPath];
  if (failOnRegression) args.push("--fail-on-regression");
  const proc = Bun.spawn(args, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, output: `${stdout}\n${stderr}` };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Mitata benchmark comparison", () => {
  test("accepts identical sampled reports", async () => {
    const report = makeReport();
    const result = await runComparator(report, report, true);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Baseline median / p99");
    expect(result.output).toContain("No regressions above 5% threshold");
  });

  test("enforces median and p99 regressions beyond tolerance", async () => {
    const result = await runComparator(makeReport(), makeReport({ median: 106, p99: 127.2 }), true);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("median +6.0%");
    expect(result.output).toContain("p99 +6.0%");
  });

  test("reports regressions without failing unless requested", async () => {
    const result = await runComparator(makeReport(), makeReport({ median: 110 }));

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("median +10.0%");
  });

  test("enforces Mitata allocation regressions", async () => {
    const result = await runComparator(makeReport(), makeReport({ heap: 1_100 }), true);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("alloc +7.4%");
  });

  test("allows initial landing when baseline lacks new benchmark", async () => {
    const result = await runComparator(makeReport({ includeReplay: false }), makeReport(), true);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("_missing_");
  });
});
