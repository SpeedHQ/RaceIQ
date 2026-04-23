/**
 * AC Evo Shared Memory Reader.
 *
 * Reuses ACC's BufferedAccMemoryReader + TripletAssembler + TripletPipeline
 * infrastructure (same shared memory format). Key differences:
 *   - Uses acEvoProcessChecker (watches AssettoCorsaEVO.exe)
 *   - Uses AcEvoParsingProcessor which resolves car/track ordinals from
 *     STATIC display names via the AC Evo CSV lookups
 */
import { BufferedAccMemoryReader } from "../acc/buffered-memory-reader";
import { TripletAssembler } from "../acc/triplet-assembler";
import { TripletPipeline, DumpToBinProcessor } from "../acc/triplet-pipeline";
import type { TripletProcessor } from "../acc/triplet-pipeline";
import { parseAcEvoBuffers, createAcEvoParserCache } from "./parser";
import type { AcEvoParserCache } from "./parser";
import { processPacket } from "../../pipeline";
import { acEvoRecorder } from "./recorder";
import { packTriplet, ACEVO_PACKED_MAGIC } from "../shared/pack-triplet";
import { PHYSICS, GRAPHICS_EVO, STATIC_EVO } from "./structs";

class AcEvoParsingProcessor implements TripletProcessor {
  private cache: AcEvoParserCache = createAcEvoParserCache();

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<void> {
    try {
      const packet = parseAcEvoBuffers(triplet.physics, triplet.graphics, triplet.staticData, this.cache);
      if (packet) {
        const rawBuf = packTriplet(ACEVO_PACKED_MAGIC, packet.CarOrdinal, packet.TrackOrdinal ?? 0, triplet.physics, triplet.graphics, triplet.staticData);
        await processPacket(packet, rawBuf);
      }
    } catch (err) {
      console.error("[AC Evo ParsingProcessor] Error:", err instanceof Error ? err.message : err);
      throw err;
    }
  }
}

export class AcEvoSharedMemoryReader {
  private _bufferedReader: BufferedAccMemoryReader;
  private _tripletAssembler: TripletAssembler;
  private _pipeline: TripletPipeline;
  private _running = false;
  private _connected = false;
  private _recordingOnly: boolean;

  constructor(recordingOnly = false) {
    this._bufferedReader = new BufferedAccMemoryReader({
      // AC Evo v0.6 uses acevo_pmf_* names (confirmed via handle.exe against
      // AssettoCorsaEVO.exe — ACC's acpmf_* names are not owned by the game).
      physicsName: "Local\\acevo_pmf_physics",
      graphicsName: "Local\\acevo_pmf_graphics",
      staticName: "Local\\acevo_pmf_static",
      physicsSize: PHYSICS.SIZE,
      graphicsSize: GRAPHICS_EVO.SIZE,
      staticSize: STATIC_EVO.SIZE,
      // AC Evo v0.6 graphics offset 8 is uint64 focused_car_id_a (not stable),
      // so disable change-based static re-read and just read static once.
      sessionIdOffset: null,
      logPrefix: "AC Evo",
    });
    const enableMetrics = process.env.NODE_ENV !== "production" || process.env.ACC_METRICS === "1";
    this._tripletAssembler = new TripletAssembler(this._bufferedReader, enableMetrics);
    this._pipeline = new TripletPipeline();
    this._recordingOnly = recordingOnly;

    if (this._recordingOnly) {
      const recordPath = acEvoRecorder.start(undefined, "ac-evo");
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

    // Process detection is handled by the central supervisor in server/index.ts.
    this._onDetected();
  }

  async stop(): Promise<void> {
    this._running = false;
    await this._tripletAssembler.stop();
    await this._bufferedReader.stop();
    this._connected = false;
    console.log("[AC Evo] Shared memory reader stopped");
  }

  private _onDetected(): void {
    if (this._connected) return;

    console.log("[AC Evo] AC Evo process detected, starting buffered reader...");

    this._bufferedReader.start();
    this._connected = true;

    // StatusCheck is skipped for AC Evo v0.6: the `status` byte at offset 4 in
    // Local\acpmf_graphics stays at 0 even during live sessions (page appears
    // to be a legacy stub), so using it as a gate silences every real packet.
    // Always parse — let the UI show whatever the page has so we can diagnose.
    if (this._recordingOnly) {
      this._pipeline.register(
        new DumpToBinProcessor(acEvoRecorder),
        new AcEvoParsingProcessor(),
      );
      console.log("[AC Evo] Triplet pipeline: DumpToBinProcessor → AcEvoParsingProcessor");
    } else {
      this._pipeline.register(new AcEvoParsingProcessor());
      console.log("[AC Evo] Triplet pipeline: AcEvoParsingProcessor");
    }

    this._tripletAssembler.start(this._pipeline.process.bind(this._pipeline));

    console.log("[AC Evo] Connected - buffers reading and pipeline active");
  }

}
