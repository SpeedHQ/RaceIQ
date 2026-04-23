/**
 * Triplet processing pipeline.
 *
 * Defines processors that handle triplets from BufferedAccMemoryReader.
 * Can be composed and chained for different modes (recording, parsing, etc).
 */

import { GRAPHICS, STATIC, AC_STATUS } from "./structs";
import { parseAccBuffers } from "./parser";
import { processPacket } from "../../pipeline";
import { packTriplet, ACC_PACKED_MAGIC } from "../shared/pack-triplet";
import { readWString } from "./utils";
import { getAccCarByModel } from "../../../shared/acc-car-data";
import { getAccTrackByName } from "../../../shared/acc-track-data";

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
  private disconnectOnOff: boolean;
  constructor(onDisconnect: () => Promise<void>, label = "ACC", disconnectOnOff = true) {
    this.onDisconnect = onDisconnect;
    this.label = label;
    this.disconnectOnOff = disconnectOnOff;
  }

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<boolean> {
    const status = triplet.graphics.readInt32LE(GRAPHICS.status.offset);
    if (status !== AC_STATUS.AC_LIVE) {
      if (!this.loggedInvalidStatus) {
        console.log(`[${this.label} StatusCheck] Invalid status: ${status} (AC_LIVE=${AC_STATUS.AC_LIVE}, AC_OFF=${AC_STATUS.AC_OFF})`);
        this.loggedInvalidStatus = true;
      }
      if (status === AC_STATUS.AC_OFF && this.disconnectOnOff) {
        console.log(`[${this.label} StatusCheck] AC_OFF detected, disconnecting`);
        await this.onDisconnect();
      }
      return false; // halt pipeline for this frame; reader keeps polling
    }
    // Status is valid, pipeline continues
    if (this.loggedInvalidStatus) {
      console.log(`[${this.label} StatusCheck] Status now AC_LIVE, resuming`);
    }
    this.loggedInvalidStatus = false;
    return true;
  }
}

/**
 * DumpToBinProcessor: writes raw buffers to .bin file (recording mode).
 */
export class DumpToBinProcessor implements TripletProcessor {
  private recorder: any;
  constructor(recorder: any) {
    this.recorder = recorder;
  }

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<void> {
    this.recorder.writePhysics(triplet.physics);
    this.recorder.writeGraphics(triplet.graphics);
    this.recorder.writeStatic(triplet.staticData);
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
      if (this.carOrdinal === 0 && triplet.staticData.length >= STATIC.SIZE) {
        const cm = readWString(triplet.staticData, STATIC.carModel.offset, STATIC.carModel.size);
        if (cm) this.carOrdinal = getAccCarByModel(cm)?.id ?? 0;
      }
      if (this.trackOrdinal === 0 && triplet.staticData.length >= STATIC.SIZE) {
        const tn = readWString(triplet.staticData, STATIC.track.offset, STATIC.track.size);
        if (tn) this.trackOrdinal = getAccTrackByName(tn)?.id ?? 0;
      }
      const packet = parseAccBuffers(triplet.physics, triplet.graphics, triplet.staticData, {
        carOrdinal: this.carOrdinal,
        trackOrdinal: this.trackOrdinal,
        gameId: this.gameId,
      });
      if (packet) {
        const rawBuf = packTriplet(ACC_PACKED_MAGIC, this.carOrdinal, this.trackOrdinal, triplet.physics, triplet.graphics, triplet.staticData);
        await processPacket(packet, rawBuf);
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
