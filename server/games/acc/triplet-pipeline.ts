/**
 * Triplet processing pipeline.
 *
 * Defines processors that handle triplets from BufferedAccMemoryReader.
 * Can be composed and chained for different modes (recording, parsing, etc).
 */

import { GRAPHICS, AC_STATUS } from "./structs";

export interface TripletProcessor {
  /** Return false to halt the pipeline for this triplet (e.g. invalid status). */
  process(triplet: {
    physics: Buffer;
    graphics: Buffer;
    staticData: Buffer;
  }): Promise<boolean | void>;
}

/**
 * StatusCheckProcessor: validates ACC status before processing.
 * Filters out invalid status and disconnects on AC_OFF.
 */
export class StatusCheckProcessor implements TripletProcessor {
  private onDisconnect: () => Promise<void>;
  private loggedInvalidStatus = false;
  private label: string;
  constructor(onDisconnect: () => Promise<void>, label = "ACC") {
    this.onDisconnect = onDisconnect;
    this.label = label;
  }

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<boolean> {
    const status = triplet.graphics.readInt32LE(GRAPHICS.status.offset);
    if (status !== AC_STATUS.AC_LIVE) {
      if (!this.loggedInvalidStatus) {
        console.log(`[${this.label} StatusCheck] Invalid status: ${status} (AC_LIVE=${AC_STATUS.AC_LIVE}, AC_OFF=${AC_STATUS.AC_OFF})`);
        this.loggedInvalidStatus = true;
      }
      if (status === AC_STATUS.AC_OFF) {
        console.log(`[${this.label} StatusCheck] AC_OFF detected, disconnecting`);
        await this.onDisconnect();
      }
      return false; // halt pipeline
    }
    // Status is valid, pipeline continues
    this.loggedInvalidStatus = false;
    return true;
  }
}

/**
 * DumpToBinProcessor: writes raw buffers to .bin file (recording mode).
 */
export class DumpToBinProcessor implements TripletProcessor {
  private accRecorder: any;
  constructor(accRecorder: any) {
    this.accRecorder = accRecorder;
  }

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
  private carOrdinal: number;
  private trackOrdinal: number;
  private gameId: import("../../../shared/types").GameId;
  private label: string;

  constructor(
    carOrdinal: number,
    trackOrdinal: number,
    _accRecorder?: any,
    gameId: import("../../../shared/types").GameId = "acc",
    label = "ACC",
  ) {
    this.carOrdinal = carOrdinal;
    this.trackOrdinal = trackOrdinal;
    this.gameId = gameId;
    this.label = label;
  }

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<void> {
    try {
      const { parseAccBuffers } = require("./parser") as typeof import("./parser");
      const { processPacket } = require("../../pipeline");

      const packet = parseAccBuffers(triplet.physics, triplet.graphics, triplet.staticData, {
        carOrdinal: this.carOrdinal,
        trackOrdinal: this.trackOrdinal,
        gameId: this.gameId,
      });
      if (packet) {
        await processPacket(packet);
      }
    } catch (err) {
      console.error(`[${this.label} ParsingProcessor] Error:`, err instanceof Error ? err.message : err);
      throw err;
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
      const result = await processor.process(triplet);
      if (result === false) break;
    }
  }
}
