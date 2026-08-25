export interface TimingChildReport {
  iterations: number;
  warmupIterations: number;
  samplesNs: number[];
}

export interface RetainedHeapChildReport {
  retainedHeap: number;
}

export type ChildBenchmarkConfig = {
  readonly command: string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly kind?: "timing" | "retainedHeap";
};

function isTimingReport(value: unknown): value is TimingChildReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Partial<TimingChildReport>;
  const { iterations, warmupIterations, samplesNs } = report;
  return typeof iterations === "number" && Number.isInteger(iterations) && iterations > 0
    && typeof warmupIterations === "number" && Number.isInteger(warmupIterations) && warmupIterations >= 0
    && Array.isArray(samplesNs)
    && samplesNs.length === iterations
    && samplesNs.every((sample) => typeof sample === "number" && Number.isFinite(sample) && sample >= 0);
}

function isRetainedHeapReport(value: unknown): value is RetainedHeapChildReport {
  return typeof value === "object" && value !== null
    && typeof (value as RetainedHeapChildReport).retainedHeap === "number"
    && Number.isFinite((value as RetainedHeapChildReport).retainedHeap)
    && (value as RetainedHeapChildReport).retainedHeap >= 0;
}

export async function runChildBenchmark(config: ChildBenchmarkConfig): Promise<unknown> {
  if (config.command.length === 0) throw new Error("Child benchmark command must not be empty");
  const child = Bun.spawn(config.command, {
    cwd: config.cwd,
    env: config.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Child benchmark exited with code ${exitCode}: ${stderr.trim()}`);
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error(`Expected one JSON line from child benchmark, received ${lines.length}`);
  let report: unknown;
  try {
    report = JSON.parse(lines[0]!);
  } catch (error) {
    throw new Error(`Child benchmark emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (config.kind === "timing" && !isTimingReport(report)) throw new Error("Child benchmark timing report has invalid fixed counts or samples");
  if (config.kind === "retainedHeap" && !isRetainedHeapReport(report)) throw new Error("Child benchmark retained heap must be finite and non-negative");
  return report;
}
