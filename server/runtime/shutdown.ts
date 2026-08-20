import { accRecorder } from "../games/kunos/recorder";
import { acEvoRecorder } from "../games/ac-evo/recorder";
import { iracingRecorder } from "../games/iracing/recorder";
import { flushSessionRecorder } from "../telemetry/live-pipeline";
import { stopSessionCompressor } from "../session-capture/compressor";
import { udpListener } from "./udp-listener";
import type { NativeSourceSupervisor } from "./native-sources";

export const GRACEFUL_SHUTDOWN_IPC_MESSAGE = "raceiq:graceful-shutdown";

export interface ShutdownOptions {
  recordingGameId: string | null;
  getNativeSources(): NativeSourceSupervisor | null;
}

export function installShutdown({ recordingGameId, getNativeSources }: ShutdownOptions): void {
  let shuttingDown = false;
  const gracefulShutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Server] Received ${signal} — flushing session recorder...`);
    stopSessionCompressor();
    try {
      const sourceStops: Promise<unknown>[] = [udpListener.stop()];
      const nativeSources = getNativeSources();
      if (nativeSources) sourceStops.push(nativeSources.stop());
      if (recordingGameId) {
        sourceStops.push(accRecorder.stop(), acEvoRecorder.stop(), iracingRecorder.stop());
      }
      await Promise.allSettled(sourceStops);
      await flushSessionRecorder();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("message", (message) => {
    if (message === GRACEFUL_SHUTDOWN_IPC_MESSAGE) {
      void gracefulShutdown("SIGINT");
    }
  });
}
