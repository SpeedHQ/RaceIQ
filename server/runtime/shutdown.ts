import { flushSessionRecorder } from "../telemetry/live-pipeline";
import { stopSessionCompressor } from "../session-capture/compressor";
import { udpListener } from "./udp-listener";
import type { NativeSourceSupervisor } from "./native-sources";

export interface ShutdownOptions {
  getNativeSources(): NativeSourceSupervisor | null;
}

export function installShutdown({
  getNativeSources,
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
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
}
