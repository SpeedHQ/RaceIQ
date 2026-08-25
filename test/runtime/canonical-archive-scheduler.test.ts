import { expect, test } from "bun:test";
import { scheduleCanonicalArchiveJobs } from "../../server/runtime/canonical-archive-scheduler";

test("archive workers do not repeat full recovery sweeps", async () => {
  const calls: string[] = [];
  const scheduled: Array<{
    callback: () => void | Promise<void>;
    intervalMs: number;
  }> = [];

  await scheduleCanonicalArchiveJobs({
    recoverInterruptedState: async () => {
      calls.push("recover");
    },
    enqueueStableCaptureJobs: async () => {
      calls.push("sweep");
    },
    runCanonicalArchiveJobOnce: async () => {
      calls.push("run");
      return false;
    },
    setInterval: (callback, intervalMs) => {
      scheduled.push({ callback, intervalMs });
      return { unref() {} };
    },
    onError: (error) => {
      throw error;
    },
  });

  expect(calls).toEqual(["recover", "sweep", "run"]);
  expect(scheduled.map(({ intervalMs }) => intervalMs)).toEqual([
    15_000,
    6 * 60 * 60_000,
  ]);

  calls.length = 0;
  await scheduled[0]!.callback();
  expect(calls).toEqual(["recover", "run"]);

  calls.length = 0;
  await scheduled[1]!.callback();
  expect(calls).toEqual(["recover", "sweep", "run"]);
});
