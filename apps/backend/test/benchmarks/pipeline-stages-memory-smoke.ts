import { beginMemoryWindow } from "./pipeline-stages-memory-sampler";

/** Callable fixture-exclusion and in-window allocation smoke check. */
export function smokePipelineStageMemorySampler(): { fixtureExcludedBytes: number; emptyWindowBytes: number; workloadGrowthBytes: number } {
  const heldFixture = Buffer.alloc(64 * 1024 * 1024, 1);
  const emptyWindow = beginMemoryWindow();
  const emptyWindowBytes = emptyWindow.finish().peakAdditionalBytes;
  if (heldFixture.byteLength !== 64 * 1024 * 1024) throw Error("Held fixture buffer unexpectedly changed");
  if (emptyWindowBytes >= 128 * 1024) throw Error(`Pre-window fixture was charged to measurement: ${emptyWindowBytes}`);
  let workload: { index: number; payload: string }[] | undefined;
  const workloadWindow = beginMemoryWindow(() => workload);
  workload = Array.from({ length: 40_000 }, (_, index) => ({ index, payload: `pipeline-memory-${index}` }));
  const workloadGrowthBytes = workloadWindow.sample();
  workload = undefined;
  const measured = workloadWindow.finish();
  if (measured.peakAdditionalBytes < workloadGrowthBytes) throw Error("Sampled peak was lost after workload release");
  if (measured.peakAdditionalBytes >= 32 * 1024 * 1024) throw Error(`In-window sample charged held fixture: ${measured.peakAdditionalBytes}`);
  if (!Number.isFinite(workloadGrowthBytes) || workloadGrowthBytes <= 0) throw Error(`In-window workload did not register as heap growth: ${workloadGrowthBytes}`);
  return { fixtureExcludedBytes: heldFixture.byteLength, emptyWindowBytes, workloadGrowthBytes };
}
