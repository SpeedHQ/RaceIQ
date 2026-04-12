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
import { TripletPipeline, StatusCheckProcessor } from "../acc/triplet-pipeline";
import type { TripletProcessor } from "../acc/triplet-pipeline";
import { parseAcEvoBuffers, createAcEvoParserCache } from "./parser";
import type { AcEvoParserCache } from "./parser";
import { acEvoProcessChecker } from "./process-checker";

class AcEvoParsingProcessor implements TripletProcessor {
  private cache: AcEvoParserCache = createAcEvoParserCache();

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<void> {
    try {
      const { processPacket } = require("../../pipeline");
      const packet = parseAcEvoBuffers(triplet.physics, triplet.graphics, triplet.staticData, this.cache);
      if (packet) await processPacket(packet);
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

  constructor() {
    this._bufferedReader = new BufferedAccMemoryReader();
    const enableMetrics = process.env.NODE_ENV !== "production" || process.env.ACC_METRICS === "1";
    this._tripletAssembler = new TripletAssembler(this._bufferedReader, enableMetrics);
    this._pipeline = new TripletPipeline();
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

    acEvoProcessChecker.on("ac-evo-detected", () => this._onDetected());
    acEvoProcessChecker.on("ac-evo-lost", () => this._onLost());

    acEvoProcessChecker.start();
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

    this._pipeline.register(new StatusCheckProcessor(this._disconnect.bind(this), "AC Evo"));
    this._pipeline.register(new AcEvoParsingProcessor());

    console.log("[AC Evo] Triplet pipeline: StatusCheckProcessor → AcEvoParsingProcessor");

    this._tripletAssembler.start(this._pipeline.process.bind(this._pipeline));

    console.log("[AC Evo] Connected - buffers reading and pipeline active");
  }

  private async _disconnect(): Promise<void> {
    if (this._connected) {
      this._connected = false;
      await this._tripletAssembler.stop();
      await this._bufferedReader.stop();
      console.log("[AC Evo] Disconnected from shared memory");
    }
  }

  private _onLost(): void {
    console.log("[AC Evo] AC Evo process lost, disconnecting...");
    this._disconnect();
  }
}
