import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

export async function killAndWait(
  proc: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs = 10_000,
): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const { promise, resolve: resolveExit, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => reject(new Error(`process did not exit within ${timeoutMs}ms`)),
    timeoutMs,
  );
  proc.on("exit", () => {
    clearTimeout(timer);
    resolveExit();
  });
  if (proc.connected) proc.send({ type: "shutdown" });
  else proc.kill(signal);
  return promise;
}

export async function removeProcessDirectory(dataDir: string): Promise<void> {
  // Windows sometimes holds file handles briefly after spawned server exits.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 9) throw error;
      const retry = Promise.withResolvers<void>();
      setTimeout(retry.resolve, 200);
      await retry.promise;
    }
  }
}
