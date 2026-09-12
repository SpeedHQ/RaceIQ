/**
 * TripletAssembler polls a memory reader at fixed 100Hz and assembles
 * complete {physics, graphics, staticData} triplets from the latest buffers.
 *
 * This decouples source reading rates (physics 300Hz, graphics 60Hz, static once)
 * from the deterministic assembly rate (100Hz main loop), matching production behavior.
 *
 * Includes observability for latency and jitter monitoring.
 */

import type { IRealtimeKunosMemoryReader } from "./memory-reader";
import type { Triplet } from "./triplet-pipeline";
import { logger } from "../../runtime/logger";

interface PollingMetrics {
  callbackDurationMs: number[];
  pollIntervalMs: number[];
  missedTriplets: number;
  successfulTriplets: number;
  totalPolls: number;
}
export class OrderedTripletDispatcher {
  private readonly process: (triplet: Triplet) => Promise<void>;
  private readonly onError?: (error: unknown) => void;
  private readonly queue: Triplet[] = [];
  private accepting = true;
  private drainPromise: Promise<void> | null = null;
  private _pendingCount = 0;

  constructor(
    process: (triplet: Triplet) => Promise<void>,
    onError?: (error: unknown) => void,
  ) {
    this.process = process;
    this.onError = onError;
  }

  get pendingCount(): number {
    return this._pendingCount;
  }

  enqueue(triplet: Triplet): boolean {
    if (!this.accepting) return false;
    this.queue.push(triplet);
    this._pendingCount++;
    this.drainPromise ??= this.drain();
    return true;
  }

  async close(): Promise<void> {
    this.accepting = false;
    await this.drainPromise;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const triplet = this.queue.shift()!;
      try {
        await this.process(triplet);
      } catch (error) {
        try {
          this.onError?.(error);
        } catch (reportingError) {
          console.error("[OrderedTripletDispatcher] Error reporter failed:", reportingError);
        }
      } finally {
        this._pendingCount--;
      }
    }
    this.drainPromise = null;
  }
}

export class TripletAssembler {
  private _memoryReader: IRealtimeKunosMemoryReader;
  private _pollingTimer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _dispatcher: OrderedTripletDispatcher | null = null;

  // Observability
  private _metrics: PollingMetrics = {
    callbackDurationMs: [],
    pollIntervalMs: [],
    missedTriplets: 0,
    successfulTriplets: 0,
    totalPolls: 0,
  };
  private _lastPollTime = 0;
  private _metricsInterval: ReturnType<typeof setInterval> | null = null;
  private _enableMetrics = false;
  private readonly _logPrefix: string;
  private _lastPhysicsPacketId: number | null = null;
  private _lastGraphicsPacketId: number | null = null;

  constructor(memoryReader: IRealtimeKunosMemoryReader, enableMetrics = false, logPrefix = "Kunos") {
    this._memoryReader = memoryReader;
    this._enableMetrics = enableMetrics;
    this._logPrefix = logPrefix;
  }

  start(callback: (triplet: Triplet) => Promise<void>): void {
    if (this._running) return;
    this._running = true;
    this._lastPollTime = performance.now();
    this._dispatcher = new OrderedTripletDispatcher(
      async (triplet) => {
        const callbackStartTime = performance.now();
        await callback(triplet);

        const callbackDurationMs = performance.now() - callbackStartTime;
        if (callbackDurationMs >= 50) {
          logger.trace(
            {
              component: "capture",
              event: "downstream-slow",
              game: this._logPrefix,
              durationMs: callbackDurationMs,
              queueDepth: this._dispatcher?.pendingCount ?? 0,
            },
            "Kunos capture downstream processing slow",
          );
        } else if (this._enableMetrics && callbackDurationMs > 5) {
          console.warn(
            `[TripletAssembler] Slow callback: ${callbackDurationMs.toFixed(1)}ms (target: <10ms)`,
          );
        }

        if (this._enableMetrics) {
          this._metrics.successfulTriplets++;
          this._metrics.callbackDurationMs.push(callbackDurationMs);
        }
      },
      (error) => console.error("[TripletAssembler] Error in callback:", error),
    );

    // Poll at 100Hz (every 10ms). Snapshot references synchronously so polling
    // never waits for downstream persistence; the dispatcher owns FIFO drain.
    this._pollingTimer = setInterval(() => {
      const pollStartTime = performance.now();
      const intervalMs = pollStartTime - this._lastPollTime;

      if (this._enableMetrics) {
        this._metrics.pollIntervalMs.push(intervalMs);
      }

      const buffers = this._memoryReader.getLatestBuffers();
      if (buffers.physics && buffers.graphics && buffers.staticData) {
        const physicsPacketId = buffers.physics.length >= 4 ? buffers.physics.readInt32LE(0) : null;
        const graphicsPacketId = buffers.graphics.length >= 4 ? buffers.graphics.readInt32LE(0) : null;
        const physicsDelta = physicsPacketId !== null && this._lastPhysicsPacketId !== null
          ? physicsPacketId - this._lastPhysicsPacketId
          : 0;
        const graphicsDelta = graphicsPacketId !== null && this._lastGraphicsPacketId !== null
          ? graphicsPacketId - this._lastGraphicsPacketId
          : 0;

        if (intervalMs >= 50) {
          logger.trace(
            {
              component: "capture",
              event: "assembler-gap",
              game: this._logPrefix,
              intervalMs,
              queueDepth: this._dispatcher!.pendingCount,
              physicsPacketDelta: physicsDelta,
              graphicsPacketDelta: graphicsDelta,
            },
            "Kunos capture assembler polling gap",
          );
        }
        if (physicsDelta > 30 || graphicsDelta > 20) {
          logger.trace(
            {
              component: "capture",
              event: "source-gap",
              game: this._logPrefix,
              physicsPacketId,
              physicsPacketDelta: physicsDelta,
              graphicsPacketId,
              graphicsPacketDelta: graphicsDelta,
            },
            "Kunos source packet sequence gap",
          );
        }

        this._lastPhysicsPacketId = physicsPacketId;
        this._lastGraphicsPacketId = graphicsPacketId;
        this._dispatcher!.enqueue({
          physics: buffers.physics,
          graphics: buffers.graphics,
          staticData: buffers.staticData,
        });
      } else if (this._enableMetrics) {
        this._metrics.missedTriplets++;
      }

      this._lastPollTime = pollStartTime;
      this._metrics.totalPolls++;
    }, 1000 / 100); // 10ms

    console.log(`[TripletAssembler] Started at 100Hz${this._enableMetrics ? " (observability enabled)" : ""}`);

    // Log metrics periodically (every 5s)
    if (this._enableMetrics) {
      this._metricsInterval = setInterval(() => this._logMetrics(), 5000);
    }
  }

  async stop(): Promise<void> {
    this._running = false;
    if (this._pollingTimer) {
      clearInterval(this._pollingTimer);
      this._pollingTimer = null;
    }
    const dispatcher = this._dispatcher;
    if (dispatcher) {
      await dispatcher.close();
      if (this._dispatcher === dispatcher) this._dispatcher = null;
    }
    if (this._metricsInterval) {
      clearInterval(this._metricsInterval);
      this._metricsInterval = null;
    }
    if (this._enableMetrics) {
      this._logMetrics();
    }
    console.log("[TripletAssembler] Stopped");
  }

  private _logMetrics(): void {
    if (this._metrics.totalPolls === 0) return;

    const durations = this._metrics.callbackDurationMs;
    const intervals = this._metrics.pollIntervalMs;

    const avgDurationMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const maxDurationMs = durations.length > 0 ? Math.max(...durations) : 0;

    const avgIntervalMs = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
    const maxIntervalMs = intervals.length > 0 ? Math.max(...intervals) : 0;
    const p95IntervalMs =
      intervals.length > 0
        ? intervals.sort((a, b) => a - b)[Math.floor(intervals.length * 0.95)]
        : 0;

    console.log(
      `[TripletAssembler] Metrics (${this._metrics.totalPolls} polls): ` +
        `triplets ${this._metrics.successfulTriplets} ok / ${this._metrics.missedTriplets} incomplete, ` +
        `callback avg ${avgDurationMs.toFixed(2)}ms / max ${maxDurationMs}ms, ` +
        `interval avg ${avgIntervalMs.toFixed(2)}ms / p95 ${p95IntervalMs}ms / max ${maxIntervalMs}ms`
    );
  }
}
