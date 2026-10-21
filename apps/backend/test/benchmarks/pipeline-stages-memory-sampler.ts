import { gcAndSweep } from "bun:jsc";

export type MemorySample = { peakAdditionalBytes: number; retainedAdditionalBytes: number };

const rootsKey = Symbol("raceiq-pipeline-memory-roots");
const roots = globalThis as unknown as Record<symbol, unknown>;

/** Measure JSC live heap growth from a post-GC baseline. Keep trial-owned values reachable through finish(). */
export function beginMemoryWindow(retain?: () => unknown): { sample(): number; finish(): MemorySample } {
  let baseline = 0;
  let peak = 0;
  const sample = () => {
    roots[rootsKey] = retain?.();
    try {
      const additional = Math.max(0, gcAndSweep() - baseline);
      peak = Math.max(peak, additional);
      return additional;
    } finally {
      roots[rootsKey] = undefined;
    }
  };
  const window = { sample, finish: () => { const retained = sample(); return { peakAdditionalBytes: Math.max(peak, retained), retainedAdditionalBytes: retained }; } };
  roots[rootsKey] = retain?.();
  gcAndSweep();
  baseline = gcAndSweep();
  roots[rootsKey] = undefined;
  return window;
}
