import { closeDb } from "@raceiq/backend-core/db/index";
import { closeDashboardReadDatabase } from "@raceiq/backend-core/db/dashboard-queries";
import { stopDatabaseWriteAuthority } from "@raceiq/backend-core/db/write-coordination";
import { flushSessionRecorder } from "@raceiq/backend-core/telemetry/live-pipeline";
import { stopSessionCompressor } from "@raceiq/backend-core/session-capture/compressor";
import { udpListener } from "./udp-listener";
import type { NativeSourceSupervisor } from "./native-sources";
import type { StartupWorkerHandle } from "./startup-worker";
import { stopSessionCaptureSplitManager } from "../session-capture/split-manager";
import { drainLayoutMigration, stopLayoutMigrationAdmission } from "@raceiq/backend-core/session-capture/layout-migration";

export interface ShutdownOptions {
  getNativeSources(): NativeSourceSupervisor | null;
  getStartupWorker(): StartupWorkerHandle | null;
  clearDashboardPublicationNotifications(): void;
}

export function installShutdown({ getNativeSources, getStartupWorker, clearDashboardPublicationNotifications }: ShutdownOptions): void {
  let shutdownPromise: Promise<void> | null = null;
  const gracefulShutdown = (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    console.log(`[Server] Received ${signal} — flushing session recorder...`);
    stopLayoutMigrationAdmission();
    const startupStop = getStartupWorker()?.stop();
    // Observe rejection immediately while the other ingress owners are draining.
    const startupSettled = Promise.resolve(startupStop).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    shutdownPromise = (async () => {
      let failed = false;
      const settle = async (owner: string, drain: () => Promise<unknown>) => {
        try { await drain(); }
        catch (error) { failed = true; console.error(`[Server] ${owner} shutdown failed:`, error); }
      };
      await settle("Layout migration", drainLayoutMigration);
      await settle("Recording maintenance", stopSessionCompressor);
      const ingress = await Promise.allSettled([
        Promise.resolve().then(() => udpListener.stop()),
        Promise.resolve().then(() => getNativeSources()?.stop()),
      ]);
      for (const result of ingress) if (result.status === "rejected") { failed = true; console.error("[Server] Ingress shutdown failed:", result.reason); }
      await settle("Recorder", flushSessionRecorder);
      await settle("Capture splitting", stopSessionCaptureSplitManager);
      const startup = await startupSettled;
      if (!startup.ok) { failed = true; console.error("[Server] Startup worker shutdown failed:", startup.error); }
      // Never exit from a finally block: a diagnostic failure must not bypass
      // another owner's protected I/O, finalizers, or the global write drain.
      await stopDatabaseWriteAuthority();
      await settle("Dashboard read connection", async () => { closeDashboardReadDatabase(); });
      await settle("Database connections", async () => { closeDb(); });
      clearDashboardPublicationNotifications();
      process.exit(failed ? 1 : 0);
    })();
    return shutdownPromise;
  };
  const onSignal = (signal: NodeJS.Signals) => { void gracefulShutdown(signal).catch((error) => console.error("[Server] Shutdown could not safely finish:", error)); };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}
