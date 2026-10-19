import { flushSessionRecorder } from "@raceiq/backend-core/telemetry/live-pipeline";
import { stopSessionCompressor } from "@raceiq/backend-core/session-capture/compressor";
import { udpListener } from "./udp-listener";
import type { NativeSourceSupervisor } from "./native-sources";
import type { StartupWorkerHandle } from "./startup-worker";
import type { OnlineUploadCoordinator } from "@raceiq/online/coordinator";
import { stopSessionCaptureSplitManager } from "../session-capture/split-manager";

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
    try {
      await getOnlineUploadCoordinator()?.stop();
      try {
        await stopSessionCompressor();
      } catch (error) {
        console.error("[Server] Recording maintenance shutdown failed:", error);
      }
      const ingressStops: Promise<unknown>[] = [udpListener.stop()];
      const nativeSources = getNativeSources();
      if (nativeSources) ingressStops.push(nativeSources.stop());
      await Promise.allSettled(ingressStops);
      await Promise.allSettled([flushSessionRecorder()]);
      await stopSessionCaptureSplitManager();
      await getStartupWorker()?.stop();
    } finally {
      clearDashboardPublicationNotifications();
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
}
