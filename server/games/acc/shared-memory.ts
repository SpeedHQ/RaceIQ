/**
 * ACC Shared Memory Reader using Bun FFI with BufferedAccMemoryReader + TripletAssembler.
 *
 * Architecture:
 *   BufferedAccMemoryReader (reads at native rates: 300Hz physics, 60Hz graphics, once static)
 *     → TripletAssembler (polls at 100Hz)
 *       → TripletPipeline (processes via registered processors)
 *
 * Pipeline processors:
 *   - DumpToBinProcessor (recording mode only): writes raw buffers to .bin
 *   - ParsingProcessor (always): parses and feeds to pipeline
 *
 * Uses kernel32.dll via Bun FFI to open and map shared memory.
 */
import { accRecorder } from "./recorder";
import { BufferedAccMemoryReader } from "./buffered-memory-reader";
import { TripletAssembler } from "./triplet-assembler";
import { TripletPipeline, StatusCheckProcessor, DumpToBinProcessor, ParsingProcessor } from "./triplet-pipeline";
import { acquireHighResolutionTimer, releaseHighResolutionTimer } from "../shared/win-timer-resolution";

// Re-export utilities so tests can import readWString from this module
export { readWString, toWideString } from "./utils";

export class AccSharedMemoryReader {
  private _bufferedReader: BufferedAccMemoryReader;
  private _tripletAssembler: TripletAssembler;
  private _pipeline: TripletPipeline;
  private _running = false;
  private _connected = false;
  // -1 = not yet resolved from static data. 0 is a real ACC ordinal (Monza /
  // first car in the list), so it can't double as the "unknown" sentinel —
  // see triplet-pipeline.ts ParsingProcessor.
  private _carOrdinal = -1;
  private _trackOrdinal = -1;
  private _retryTimer: ReturnType<typeof setInterval> | null = null;
  private _recordingEnabled = false;
  /** True while we hold a timer-resolution reference, so stop() releases exactly one. */
  private _holdsTimerResolution = false;

  constructor(recordingEnabled = false) {
    this._bufferedReader = new BufferedAccMemoryReader();
    // Enable metrics in dev mode or when ACC_METRICS=1
    const enableMetrics = process.env.NODE_ENV !== "production" || process.env.ACC_METRICS === "1";
    this._tripletAssembler = new TripletAssembler(this._bufferedReader, enableMetrics);
    this._pipeline = new TripletPipeline();
    this._recordingEnabled = recordingEnabled;

    // If recording mode, start bin file immediately (one per server session)
    if (this._recordingEnabled) {
      const recordPath = accRecorder.start();
      console.log(`[ACC] Recording mode: bin file created at ${recordPath}`);
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  get running(): boolean {
    return this._running;
  }

  /** Read current raw buffers for debugging. Returns null if not connected. */
  getDebugBuffers(): { physics: Buffer; graphics: Buffer; staticData: Buffer } | null {
    return this._bufferedReader.getDebugBuffers();
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    console.log("[ACC] Starting shared memory reader...");

    // Process detection is handled by the central supervisor in server/index.ts.
    // This reader is only instantiated once the ACC process is already running,
    // so connect immediately instead of polling for the process ourselves.
    this._onAccDetected();
  }

  async stop(): Promise<void> {
    this._running = false;
    await this._tripletAssembler.stop();
    await this._bufferedReader.stop();
    if (this._retryTimer) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }
    this._connected = false;
    // Drop the timer resolution once no capture interval needs it. Guarded so a
    // stop() without a matching start() cannot underflow the refcount.
    if (this._holdsTimerResolution) {
      this._holdsTimerResolution = false;
      releaseHighResolutionTimer();
    }
    // Recording mode: this reader opened the bin file in its constructor, so
    // close it when the reader goes down (game exit / shutdown). Finalizes the
    // frameCount header instead of relying on the killed-process scan path.
    if (this._recordingEnabled) {
      await accRecorder.stop();
    }
    console.log("[ACC] Shared memory reader stopped");
  }

  private _onAccDetected(): void {
    if (this._connected) return;

    console.log("[ACC] ACC process detected, starting buffered reader...");

    // Raise the process timer resolution BEFORE any capture interval is armed.
    // On Windows the default 15.625ms tick rounds up every setInterval below it,
    // which silently collapses the reader's 300Hz/60Hz timers and the
    // assembler's 100Hz timer to ~63.5Hz. Held only for the capture's lifetime
    // because a raised resolution costs power.
    // See docs/telemetry-fidelity.md section 1.
    if (!this._holdsTimerResolution) {
      acquireHighResolutionTimer();
      this._holdsTimerResolution = true;
    }

    // Start buffered reader (loads FFI, opens shared memory, starts 300Hz/60Hz timers)
    this._bufferedReader.start();

    this._connected = true;

    // Register pipeline processors
    // Chain: StatusCheckProcessor (passes AC_LIVE + AC_PAUSE) → Mode-specific
    // processor. StatusCheckProcessor halts the pipeline for AC_OFF/AC_REPLAY
    // without tearing the reader down — the process supervisor in
    // `server/index.ts` owns reader lifecycle.
    this._pipeline.register(new StatusCheckProcessor("ACC"));

    if (this._recordingEnabled) {
      this._pipeline.register(
        new DumpToBinProcessor(accRecorder),
        new ParsingProcessor(this._carOrdinal, this._trackOrdinal, accRecorder),
      );
      console.log("[ACC] Triplet pipeline: StatusCheckProcessor → DumpToBinProcessor → ParsingProcessor");
    } else {
      this._pipeline.register(new ParsingProcessor(this._carOrdinal, this._trackOrdinal, accRecorder));
      console.log("[ACC] Triplet pipeline: StatusCheckProcessor → ParsingProcessor");
    }

    // Start assembling triplets at 100Hz
    // Buffers are being populated by 300Hz/60Hz timers, TripletAssembler will poll as they arrive
    // StatusCheckProcessor validates AC_LIVE on each triplet
    this._tripletAssembler.start(this._pipeline.process.bind(this._pipeline));

    console.log("[ACC] Connected - buffers reading and pipeline active");
  }


}
