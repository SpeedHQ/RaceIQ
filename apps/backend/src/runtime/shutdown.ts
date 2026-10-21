import { flushSessionRecorder } from "@raceiq/backend-core/telemetry/live-pipeline";
import { stopSessionCompressor } from "@raceiq/backend-core/session-capture/compressor";
import { udpListener } from "./udp-listener";
import type { NativeSourceSupervisor } from "./native-sources";
import type { StartupWorkerHandle } from "./startup-worker";
import { stopSessionCaptureSplitManager } from "../session-capture/split-manager";

export interface ShutdownOptions {
  getNativeSources(): NativeSourceSupervisor | null;
  getStartupWorker(): StartupWorkerHandle | null;
  getOnlineWorker(): {stop():Promise<void>} | null;
  clearDashboardPublicationNotifications(): void;
}

export function installShutdown({
  getNativeSources,
  getStartupWorker,
  getOnlineWorker,
  clearDashboardPublicationNotifications,
}: ShutdownOptions): void {
  const gracefulShutdown = async (signal: NodeJS.Signals) => {
    console.log(`[Server] Received ${signal} — flushing session recorder...`);
    try {
      try { await getOnlineWorker()?.stop(); }
      catch { console.error("[OnlineWorker] Shutdown grace ended; continuing local capture flush"); }
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
