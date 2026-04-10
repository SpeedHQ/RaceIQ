/**
 * Triplet processing pipeline.
 *
 * Defines processors that handle triplets from BufferedAccMemoryReader.
 * Can be composed and chained for different modes (recording, parsing, etc).
 */

import { GRAPHICS, AC_STATUS } from "./structs";

export interface TripletProcessor {
  process(triplet: {
    physics: Buffer;
    graphics: Buffer;
    staticData: Buffer;
  }): Promise<void>;
}

/**
 * StatusCheckProcessor: validates ACC status before processing.
 * Filters out invalid status and disconnects on AC_OFF.
 */
export class StatusCheckProcessor implements TripletProcessor {
  constructor(private onDisconnect: () => Promise<void>) {}

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<void> {
    const status = triplet.graphics.readInt32LE(GRAPHICS.status.offset);
    if (status !== AC_STATUS.AC_LIVE) {
      if (status === AC_STATUS.AC_OFF) {
        await this.onDisconnect();
      }
      return;
    }
    // Status is valid, pipeline continues
  }
}

/**
 * DumpToBinProcessor: writes raw buffers to .bin file (recording mode).
 */
export class DumpToBinProcessor implements TripletProcessor {
  constructor(private accRecorder: any) {}

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<void> {
    this.accRecorder.writePhysics(triplet.physics);
    this.accRecorder.writeGraphics(triplet.graphics);
    this.accRecorder.writeStatic(triplet.staticData);
  }
}

/**
 * ParsingProcessor: parses buffers and feeds to pipeline (normal mode).
 */
export class ParsingProcessor implements TripletProcessor {
  constructor(
    private carOrdinal: number,
    private trackOrdinal: number,
    private accRecorder: any
  ) {}

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<void> {
    // Record raw buffers if recording is enabled
    if (this.accRecorder.recording) {
      this.accRecorder.writePhysics(triplet.physics);
      this.accRecorder.writeGraphics(triplet.graphics);
      this.accRecorder.writeStatic(triplet.staticData);
    }

    // Parse and process
    const { parseAccBuffers } = require("./parser") as typeof import("./parser");
    const { processPacket } = require("../../pipeline");

    const packet = parseAccBuffers(triplet.physics, triplet.graphics, triplet.staticData, {
      carOrdinal: this.carOrdinal,
      trackOrdinal: this.trackOrdinal,
    });
    if (packet) {
      await processPacket(packet);
    }
  }
}

/**
 * Pipeline: orchestrates multiple triplet processors in sequence.
 */
export class TripletPipeline {
  private processors: TripletProcessor[] = [];

  register(...processors: TripletProcessor[]): void {
    this.processors.push(...processors);
  }

  async process(triplet: {
    physics: Buffer;
    graphics: Buffer;
    staticData: Buffer;
  }): Promise<void> {
    for (const processor of this.processors) {
      await processor.process(triplet);
    }
  }
}
