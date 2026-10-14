import { flushSessionRecorder } from "@raceiq/backend-core/telemetry/live-pipeline";
import { stopSessionCompressor } from "@raceiq/backend-core/session-capture/compressor";
import { udpListener } from "./udp-listener";
import type { NativeSourceSupervisor } from "./native-sources";
import type { StartupWorkerHandle } from "./startup-worker";
import type { OnlineUploadCoordinator } from "@raceiq/online/coordinator";

export interface ShutdownOptions {
  getNativeSources(): NativeSourceSupervisor | null;
  getStartupWorker(): StartupWorkerHandle | null;
  getOnlineUploadCoordinator(): OnlineUploadCoordinator | null;
  clearDashboardPublicationNotifications(): void;
}

export function installShutdown({
  getNativeSources,
  getStartupWorker,
  getOnlineUploadCoordinator,
  clearDashboardPublicationNotifications,
}: ShutdownOptions): void {
  const gracefulShutdown = async (signal: NodeJS.Signals) => {
    console.log(`[Server] Received ${signal} — flushing session recorder...`);
    stopSessionCompressor();
    try {
      await getOnlineUploadCoordinator()?.stop();
      const ingressStops: Promise<unknown>[] = [udpListener.stop()];
      const nativeSources = getNativeSources();
      if (nativeSources) ingressStops.push(nativeSources.stop());
      await Promise.allSettled(ingressStops);
      await Promise.allSettled([flushSessionRecorder()]);
      await getStartupWorker()?.stop();
    } finally {
      clearDashboardPublicationNotifications();
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
}
