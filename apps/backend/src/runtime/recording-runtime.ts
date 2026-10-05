import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { IS_COMPILED, ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { serverReleaseFeatures } from "@raceiq/backend-core/runtime/config/release-features";
import { getAllServerGames } from "@raceiq/backend-core/games/registry";
import {
  getRecorderEngine,
  pauseRecordingJobs,
  registerRecorderEngine,
  registerRecordingRuntimeShutdown,
  resumeRecordingJobs,
  setRecordingEngineKind,
  type RecorderHealthSnapshot,
  type RecorderShutdownReason,
} from "@raceiq/backend-core/runtime/recorder-engine";
import { attachRustEngine, finalizeResetBunLiveState } from "@raceiq/backend-core/telemetry/live-pipeline";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";
import { RecorderClient } from "./recorder-client";
import { udpListener } from "./udp-listener";
import { startNativeSourceSupervisor, type NativeSourceSupervisor } from "./native-sources";

export type RecordingEngineKind = "bun" | "rust";
export type RecordingRuntimeStatus = {
  engine: RecordingEngineKind | null;
  requestedEngine: RecordingEngineKind;
  state: "starting" | "ready" | "switching" | "failed" | "stopping";
  reason: string | null;
  udpPort: number;
};

export function recorderExecutablePath(): string {
  const executable = process.platform === "win32" ? "raceiq-recorder.exe" : "raceiq-recorder";
  return IS_COMPILED
    ? resolve(ROOT_DIR, executable)
    : resolve(ROOT_DIR, "native", "recorder", "target", "debug", executable);
}

/** Owns acquisition exclusively. HTTP and browser connections outlive handoffs. */
class RecordingRuntime {
  #status: RecordingRuntimeStatus = { engine: null, requestedEngine: "bun", state: "starting", reason: null, udpPort: 5301 };
  #recordingGameId: string | null = null;
  #nativeSources: NativeSourceSupervisor | null = null;
  #detachRust: (() => Promise<void>) | null = null;
  #unsubscribeRustStatus: (() => void) | null = null;
  #operations: Promise<void> = Promise.resolve();
  #stopPromise: Promise<void> | null = null;
  #onFailure: ((reason: string) => void | Promise<void>) | null = null;

  get status(): RecordingRuntimeStatus { return { ...this.#status }; }
  get recorderHealth(): RecorderHealthSnapshot | null { return getRecorderEngine()?.health ?? null; }

  async start(options: {
    engine: RecordingEngineKind;
    udpPort: number;
    recordingGameId: string | null;
    onFailure(reason: string): void | Promise<void>;
  }): Promise<void> {
    this.#recordingGameId = options.recordingGameId;
    this.#onFailure = options.onFailure;
    this.#status = { ...this.#status, requestedEngine: options.engine, udpPort: options.udpPort };
    registerRecordingRuntimeShutdown((reason) => this.shutdown(reason));
    await this.configure(options.engine, options.udpPort);
  }

  configure(engine: RecordingEngineKind, udpPort: number): Promise<void> {
    const operation = this.#operations.then(() => this.#configure(engine, udpPort));
    // A failed request must not poison the serialization chain: an explicit
    // user selection can recover a failed handoff without restarting HTTP.
    this.#operations = operation.catch(() => {});
    return operation;
  }

  async #configure(engine: RecordingEngineKind, udpPort: number): Promise<void> {
    if (this.#stopPromise) throw new Error("Recording runtime is stopping");
    if (this.#status.engine === engine && this.#status.udpPort === udpPort && this.#status.state === "ready") return;
    if (engine === "rust" && !existsSync(recorderExecutablePath())) {
      throw new Error(IS_COMPILED
        ? `Incomplete installation: bundled recorder missing at ${recorderExecutablePath()}`
        : `Rust recorder missing at ${recorderExecutablePath()}; run bun run build:recorder`);
    }
    const switching = this.#status.engine !== null;
    this.#status = { ...this.#status, requestedEngine: engine, state: switching ? "switching" : "starting", reason: null };
    this.#publish();
    await pauseRecordingJobs();
    try {
      await this.#stopAuthority("engine-switch");
      this.#status.engine = null;
      setRecordingEngineKind(engine);
      if (engine === "bun") {
        udpListener.setRecordingGameId(this.#recordingGameId === "fm-2023" || this.#recordingGameId === "f1-2025" ? this.#recordingGameId : null);
        await udpListener.start(udpPort);
        this.#nativeSources = startNativeSourceSupervisor(this.#recordingGameId);
      } else {
        const dataDir = resolve(resolveDataDir());
        const stagingRoot = resolve(dataDir, "recorder-jobs");
        mkdirSync(stagingRoot, { recursive: true });
        const client = new RecorderClient({
          executablePath: recorderExecutablePath(),
          onUnhealthy: (reason) => this.#unhealthy(reason),
        });
        registerRecorderEngine(client);
        this.#detachRust = await attachRustEngine(client);
        udpListener.setRustStatus({ receiving: false, packetsPerSec: 0, droppedPackets: 0, port: udpPort });
        this.#unsubscribeRustStatus = client.subscribe((event) => {
          if (event.type !== "status" || !event.data || typeof event.data !== "object") return;
          const udp = (event.data as Record<string, unknown>).udp;
          if (!udp || typeof udp !== "object") return;
          const status = udp as Record<string, unknown>;
          if (typeof status.receiving !== "boolean" || !Number.isSafeInteger(status.packetsPerSec)
            || !Number.isSafeInteger(status.droppedPackets) || !Number.isInteger(status.port)) {
            throw new Error("Invalid Rust UDP status counters");
          }
          udpListener.setRustStatus({
            receiving: status.receiving,
            packetsPerSec: status.packetsPerSec as number,
            droppedPackets: status.droppedPackets as number,
            port: status.port as number,
          });
        });
        await client.start({
          dataDir,
          stagingRoot,
          udpHostname: "0.0.0.0",
          udpPort,
          featureGates: serverReleaseFeatures,
          recordingGameId: this.#recordingGameId,
          recordingDirectory: resolve(ROOT_DIR, "test", "artifacts", "sessions"),
          games: getAllServerGames().map((game) => ({ id: game.id, processNames: game.processNames ?? [] })),
        });
      }
      this.#status = { engine, requestedEngine: engine, state: "ready", reason: null, udpPort };
      resumeRecordingJobs();
      this.#publish();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try { await this.#stopAuthority("startup-failure"); }
      catch (cleanupError) { console.error("[Recorder] Failed handoff cleanup:", cleanupError); }
      this.#status = { ...this.#status, engine: null, state: "failed", reason };
      this.#publish();
      // No automatic fallback. Keep HTTP alive for an explicit selection, but
      // keep new recording/import/replay work blocked until acquisition starts.
      throw error;
    }
  }

  shutdown(reason: RecorderShutdownReason): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#operations.then(async () => {
      this.#status = { ...this.#status, state: "stopping", reason };
      this.#publish();
      await pauseRecordingJobs({ drain: false });
      await this.#stopAuthority(reason);
      await pauseRecordingJobs();
      this.#status.engine = null;
    });
    return this.#stopPromise;
  }

  async #stopAuthority(reason: RecorderShutdownReason): Promise<void> {
    const client = getRecorderEngine();
    let failure: unknown;
    if (client) {
      try { await client.shutdown(reason); }
      catch (error) {
        // Never release an authority whose process might still own sources.
        if (!(client instanceof RecorderClient) || !client.exited) throw error;
        failure = error;
      }
      try { if (this.#detachRust) await this.#detachRust(); }
      catch (error) { failure ??= error; }
      finally {
        this.#detachRust = null;
        this.#unsubscribeRustStatus?.();
        this.#unsubscribeRustStatus = null;
        registerRecorderEngine(null);
      }
    }
    const nativeSources = this.#nativeSources;
    this.#nativeSources = null;
    await Promise.all([udpListener.stop(), nativeSources?.stop()]);
    await finalizeResetBunLiveState();
    if (failure) throw failure;
  }

  async #unhealthy(reason: string): Promise<void> {
    if (this.#status.state === "stopping") return;
    const wasReady = this.#status.state === "ready";
    console.error(`[Recorder] Unhealthy: ${reason}`);
    this.#status = { ...this.#status, state: "failed", reason };
    wsManager.broadcastNotification({ type: "recorder-health", state: getRecorderEngine()?.health.state ?? "failed", reason });
    this.#publish();
    // Startup/handoff failure is handled by configure's cleanup, not a backend
    // restart. A running child's unexpected failure retains supervised stop.
    if (wasReady) await this.#onFailure?.(reason);
  }

  #publish(): void {
    wsManager.broadcastNotification({ type: "recording-engine", ...this.status });
  }
}

export const recordingRuntime = new RecordingRuntime();
