/**
 * TripletAssembler polls a memory reader at fixed 100Hz and assembles
 * complete {physics, graphics, staticData} triplets from the latest buffers.
 *
 * This decouples source reading rates (physics 300Hz, graphics 60Hz, static once)
 * from the deterministic assembly rate (100Hz main loop), matching production behavior.
 *
 * Includes observability for latency and jitter monitoring.
 */

import type { IRealtimeAccMemoryReader } from "./memory-reader";

interface PollingMetrics {
  callbackDurationMs: number[];
  pollIntervalMs: number[];
  missedTriplets: number;
  successfulTriplets: number;
  totalPolls: number;
}

export class TripletAssembler {
  private _memoryReader: IRealtimeAccMemoryReader;
  private _pollingTimer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _callback: ((triplet: {
    physics: Buffer;
    graphics: Buffer;
    staticData: Buffer;
  }) => Promise<void>) | null = null;

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

  constructor(memoryReader: IRealtimeAccMemoryReader, enableMetrics = false) {
    this._memoryReader = memoryReader;
    this._enableMetrics = enableMetrics;
  }

  start(callback: (triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }) => Promise<void>): void {
    if (this._running) return;
    this._running = true;
    this._callback = callback;
    this._lastPollTime = Date.now();

    // Poll at 100Hz (every 10ms)
    this._pollingTimer = setInterval(async () => {
      const pollStartTime = Date.now();

      if (this._enableMetrics) {
        const intervalMs = pollStartTime - this._lastPollTime;
        this._metrics.pollIntervalMs.push(intervalMs);
      }

      const buffers = this._memoryReader.getLatestBuffers();
      if (buffers.physics && buffers.graphics && buffers.staticData) {
        try {
          await this._callback!(buffers as {
            physics: Buffer;
            graphics: Buffer;
            staticData: Buffer;
          });

          if (this._enableMetrics) {
            this._metrics.successfulTriplets++;
            const callbackDurationMs = Date.now() - pollStartTime;
            this._metrics.callbackDurationMs.push(callbackDurationMs);

            if (callbackDurationMs > 5) {
              console.warn(
                `[TripletAssembler] Slow callback: ${callbackDurationMs}ms (target: <10ms)`
              );
            }
          }
        } catch (err) {
          console.error("[TripletAssembler] Error in callback:", err);
        }
      } else {
        if (this._enableMetrics) {
          this._metrics.missedTriplets++;
        }
      }

      this._lastPollTime = pollStartTime;
      this._metrics.totalPolls++;
    }, 1000 / 100); // 10ms

    console.log("[TripletAssembler] Started at 100Hz" + (this._enableMetrics ? " (observability enabled)" : ""));

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
    if (this._metricsInterval) {
      clearInterval(this._metricsInterval);
      this._metricsInterval = null;
    }
    if (this._enableMetrics) {
      this._logMetrics();
    }
    console.log("[TripletAssembler] Stopped");
  }

  running(): boolean {
    return this._running;
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
