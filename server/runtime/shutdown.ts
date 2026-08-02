import { accRecorder } from "../games/kunos/recorder";
import { acEvoRecorder } from "../games/ac-evo/recorder";
import { iracingRecorder } from "../games/iracing/recorder";
import { flushSessionRecorder } from "../pipeline";
import { stopSessionCompressor } from "../session-capture/compressor";
import { udpListener } from "../udp";
import type { NativeSourceSupervisor } from "./native-sources";

export interface ShutdownOptions {
  recordingGameId: string | null;
  getNativeSources(): NativeSourceSupervisor | null;
}

export function installShutdown({
  recordingGameId,
  getNativeSources,
}: ShutdownOptions): void {
  const gracefulShutdown = async (signal: NodeJS.Signals) => {
    console.log(`[Server] Received ${signal} — flushing session recorder...`);
    stopSessionCompressor();
    try {
      const tasks: Promise<unknown>[] = [flushSessionRecorder()];
      const nativeSources = getNativeSources();
      if (nativeSources) tasks.push(nativeSources.stop());
      if (recordingGameId) {
        tasks.push(
          udpListener.stop(),
          accRecorder.stop(),
          acEvoRecorder.stop(),
          iracingRecorder.stop(),
        );
      }
      await Promise.allSettled(tasks);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
}
