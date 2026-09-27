/**
 * AC Evo Shared Memory Reader.
 *
 * Reuses Kunos BufferedKunosMemoryReader + TripletAssembler + TripletPipeline
 * infrastructure (same shared memory format). Key differences:
 *   - Uses acEvoProcessChecker (watches AssettoCorsaEVO.exe)
 *   - Uses AcEvoParsingProcessor which resolves car/track ordinals from
 *     STATIC display names via the AC Evo CSV lookups
 *   - Live capture accepts AC_LIVE/AC_PAUSE; recording writes raw buffers only
 */

import { processPacket } from "../../telemetry/live-pipeline";
import { BufferedKunosMemoryReader } from "../kunos/buffered-memory-reader";
import type { IRealtimeKunosMemoryReader } from "../kunos/memory-reader";
import { ACEVO_PACKED_MAGIC, packTriplet } from "../kunos/pack-triplet";
import { TripletAssembler } from "../kunos/triplet-assembler";
import {
  createKunosTripletPipeline,
  TripletPipeline,
  type TripletProcessor,
} from "../kunos/triplet-pipeline";
import { acquireHighResolutionTimer, releaseHighResolutionTimer } from "../shared/win-timer-resolution";
import type { AcEvoParserCache } from "./parser";
import { createAcEvoParserCache, parseAcEvoBuffers } from "./parser";
import { acEvoRecorder } from "./recorder";
import { KunosRecorder } from "../kunos/recorder";
import { ACEVO_STATUS, GRAPHICS_EVO, PHYSICS, STATIC_EVO } from "./structs";

/** Gates live capture while AC Evo is outside a live or paused session. */
export class AcEvoStatusCheckProcessor implements TripletProcessor {
  private loggedInvalidStatus = false;

  async process(triplet: { graphics: Buffer }): Promise<boolean> {
    const status = triplet.graphics.readInt32LE(GRAPHICS_EVO.status.offset);
    if (status !== ACEVO_STATUS.AC_LIVE && status !== ACEVO_STATUS.AC_PAUSE) {
      if (!this.loggedInvalidStatus) {
        console.log(
          `[AC Evo StatusCheck] Pausing pipeline, status=${status} ` +
            `(AC_OFF=${ACEVO_STATUS.AC_OFF}, AC_REPLAY=${ACEVO_STATUS.AC_REPLAY})`,
        );
        this.loggedInvalidStatus = true;
      }
      return false;
    }
    if (this.loggedInvalidStatus) {
      console.log(`[AC Evo StatusCheck] Status=${status} — pipeline resuming`);
    }
    this.loggedInvalidStatus = false;
    return true;
  }
}

class AcEvoParsingProcessor implements TripletProcessor {
  private cache: AcEvoParserCache = createAcEvoParserCache();

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<undefined> {
    try {
      const packet = parseAcEvoBuffers(triplet.physics, triplet.graphics, triplet.staticData, this.cache);
      if (packet) {
        // -1 sentinel = unresolved. Never default to 0: ordinal 0 is a real
        // car/track (Ferrari SF90 Stradale / Monza GP).
        const sourceFrame = packTriplet(ACEVO_PACKED_MAGIC, packet.CarOrdinal, packet.TrackOrdinal ?? -1, triplet.physics, triplet.graphics, triplet.staticData);
        await processPacket(packet, sourceFrame);
      }
    } catch (err) {
      console.error("[AC Evo ParsingProcessor] Error:", err instanceof Error ? err.message : err);
      throw err;
    }
    return undefined;
  }
}

export interface AcEvoSharedMemoryReaderOptions {
  recordingEnabled?: boolean;
  memoryReader?: IRealtimeKunosMemoryReader;
  recorder?: KunosRecorder;
  recordingDir?: string;
  parser?: TripletProcessor;
  enableMetrics?: boolean;
}

export class AcEvoSharedMemoryReader {
  private _bufferedReader: IRealtimeKunosMemoryReader;
  private _tripletAssembler: TripletAssembler;
  private _pipeline: TripletPipeline;
  private _running = false;
  private _connected = false;
  private _recordingEnabled: boolean;
  private readonly _recorder: KunosRecorder;
  private readonly _recordingDir: string | undefined;
  private readonly _parser: TripletProcessor;
  /** True while we hold a timer-resolution reference, so stop() releases exactly one. */
  private _holdsTimerResolution = false;

  constructor(options: boolean | AcEvoSharedMemoryReaderOptions = false) {
    const config = typeof options === "boolean"
      ? { recordingEnabled: options }
      : options;
    this._recordingEnabled = config.recordingEnabled ?? false;
    this._bufferedReader = config.memoryReader ?? new BufferedKunosMemoryReader({
      // AC Evo v0.6 uses acevo_pmf_* names (confirmed via handle.exe against
      // AssettoCorsaEVO.exe — ACC's acpmf_* names are not owned by the game).
      physicsName: "Local\\acevo_pmf_physics",
      graphicsName: "Local\\acevo_pmf_graphics",
      staticName: "Local\\acevo_pmf_static",
      physicsSize: PHYSICS.SIZE,
      graphicsSize: GRAPHICS_EVO.SIZE,
      staticSize: STATIC_EVO.SIZE,
      sessionIdOffset: null,
      logPrefix: "AC Evo",
    });
    const enableMetrics = config.enableMetrics ??
      (process.env.NODE_ENV !== "production" || process.env.ACC_METRICS === "1");
    this._tripletAssembler = new TripletAssembler(this._bufferedReader, enableMetrics, "AC Evo");
    this._pipeline = new TripletPipeline();
    this._recorder = config.recorder ?? acEvoRecorder;
    this._recordingDir = config.recordingDir;
    this._parser = config.parser ?? new AcEvoParsingProcessor();

    if (this._recordingEnabled) {
      const recordPath = this._recorder.start(this._recordingDir, "ac-evo");
      console.log(`[AC Evo] Recording mode: bin file created at ${recordPath}`);
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
    console.log("[AC Evo] Starting shared memory reader...");

    // Process detection is handled by the central supervisor in server/runtime/native-sources.ts.
    this._onDetected();
  }

  async stop(): Promise<void> {
    this._running = false;
    await this._tripletAssembler.stop();
    await this._bufferedReader.stop();
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
      await this._recorder.stop();
    }
    console.log("[AC Evo] Shared memory reader stopped");
  }

  private _onDetected(): void {
    if (this._connected) return;

    console.log("[AC Evo] AC Evo process detected, starting buffered reader...");

    // Raise the process timer resolution BEFORE any capture interval is armed.
    // On Windows the default 15.625ms tick rounds up every setInterval below it,
    // which silently collapses the reader's 300Hz/60Hz timers and the
    // assembler's 100Hz timer to ~63.5Hz. Held only for the capture's lifetime
    // because a raised resolution costs power.
    // See docs/research/telemetry-fidelity.md section 1.
    if (!this._holdsTimerResolution) {
      acquireHighResolutionTimer();
      this._holdsTimerResolution = true;
    }

    this._bufferedReader.start();
    this._connected = true;

    this._pipeline = createKunosTripletPipeline({
      recordingEnabled: this._recordingEnabled,
      recorder: this._recorder,
      parser: this._parser,
      gate: new AcEvoStatusCheckProcessor(),
    });
    console.log(
      this._recordingEnabled
        ? "[AC Evo] Triplet pipeline: AcEvoStatusCheckProcessor → DumpToBinProcessor"
        : "[AC Evo] Triplet pipeline: AcEvoStatusCheckProcessor → AcEvoParsingProcessor",
    );

    this._tripletAssembler.start(this._pipeline.process.bind(this._pipeline));

    console.log("[AC Evo] Connected - buffers reading and pipeline active");
  }
}
