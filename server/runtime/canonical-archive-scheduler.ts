export interface CanonicalArchiveIntervalHandle {
  unref?(): void;
}

export interface CanonicalArchiveSchedulerDependencies {
  recoverInterruptedState: () => Promise<void>;
  enqueueStableCaptureJobs: () => Promise<void>;
  runCanonicalArchiveJobOnce: () => Promise<boolean>;
  setInterval: (
    callback: () => void | Promise<void>,
    intervalMs: number,
  ) => CanonicalArchiveIntervalHandle | number;
  onError: (error: unknown) => void;
}

const JOB_INTERVAL_MS = 15_000;
const RECOVERY_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

export function scheduleCanonicalArchiveJobs(
  dependencies: CanonicalArchiveSchedulerDependencies,
): Promise<void> {
  let processing = false;
  const tick = async (includeRecoverySweep: boolean) => {
    if (processing) return;
    processing = true;
    try {
      await dependencies.recoverInterruptedState();
      if (includeRecoverySweep) {
        await dependencies.enqueueStableCaptureJobs();
      }
      await dependencies.runCanonicalArchiveJobOnce();
    } catch (error) {
      dependencies.onError(error);
    } finally {
      processing = false;
    }
  };

  const startup = tick(true);
  const workerTimer = dependencies.setInterval(
    () => tick(false),
    JOB_INTERVAL_MS,
  );
  if (typeof workerTimer !== "number") workerTimer.unref?.();
  const recoverySweepTimer = dependencies.setInterval(
    () => tick(true),
    RECOVERY_SWEEP_INTERVAL_MS,
  );
  if (typeof recoverySweepTimer !== "number") recoverySweepTimer.unref?.();
  return startup;
}
