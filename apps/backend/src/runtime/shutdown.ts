import { stopSessionCompressor } from "@raceiq/backend-core/session-capture/compressor";
import { recordingRuntime } from "./recording-runtime";
import type { WSData } from "@raceiq/backend-core/runtime/websocket-manager";

export interface ShutdownOptions {
  httpServer: Bun.Server<WSData>;
}

/** One idempotent stop path for signals and recorder failures. */
export function installShutdown({ httpServer }: ShutdownOptions): (reason: string) => Promise<void> {
  let stop: Promise<void> | null = null;
  const shutdown = (reason: string, exitCode: number): Promise<void> => {
    if (stop) return stop;
    stop = (async () => {
      console.log(`[Server] Stopping: ${reason}`);
      stopSessionCompressor();
      let code = exitCode;
      try {
        await recordingRuntime.shutdown(exitCode ? "health-failure" : "signal");
      } catch (error) {
        code = 1;
        console.error("[Server] Recording shutdown failed:", error);
      } finally {
        await httpServer.stop(true);
        process.exit(code);
      }
    })();
    return stop;
  };
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  return (reason) => shutdown(reason, 1);
}
