import { flushSessionRecorder } from "@raceiq/backend-core/telemetry/live-pipeline";
import { stopSessionCompressor } from "@raceiq/backend-core/session-capture/compressor";
import { udpListener } from "./udp-listener";
import type { NativeSourceSupervisor } from "./native-sources";
import type { DashboardProcessorHandle } from "@raceiq/backend-core/session-capture/dashboard-processor";

export interface ShutdownOptions {
  getNativeSources(): NativeSourceSupervisor | null;
  getDashboardProcessor(): DashboardProcessorHandle | null;
}

export function installShutdown({
  getNativeSources,
  getDashboardProcessor,
}: ShutdownOptions): void {
  const gracefulShutdown = async (signal: NodeJS.Signals) => {
    console.log(`[Server] Received ${signal} — flushing session recorder...`);
    stopSessionCompressor();
    try {
      const ingressStops: Promise<unknown>[] = [udpListener.stop()];
      const nativeSources = getNativeSources();
      if (nativeSources) ingressStops.push(nativeSources.stop());
      await Promise.allSettled(ingressStops);
      await Promise.allSettled([flushSessionRecorder()]);
      await getDashboardProcessor()?.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
}
