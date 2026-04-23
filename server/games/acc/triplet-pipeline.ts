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
 * StatusCheckProcessor: gates the pipeline by ACC status.
 *
 * AC_LIVE and AC_PAUSE pass through — in-race frames, including those where
 * the user has the pause menu open. AC_OFF (main menu) and AC_REPLAY halt
 * the pipeline for that frame so no parser/DB work happens. The reader
 * keeps polling; the pipeline resumes automatically as soon as the user
 * enters a session again.
 *
 * This processor never tears the reader down. Reader lifecycle is owned by
 * the process supervisor in `server/index.ts` — disconnecting here on
 * AC_OFF left the reader dead until the user relaunched the app.
 */
export class StatusCheckProcessor implements TripletProcessor {
  private loggedInvalidStatus = false;
  private label: string;
  constructor(label = "ACC") {
    this.label = label;
  }

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<boolean> {
    const status = triplet.graphics.readInt32LE(GRAPHICS.status.offset);
    if (status !== AC_STATUS.AC_LIVE && status !== AC_STATUS.AC_PAUSE) {
      if (!this.loggedInvalidStatus) {
        console.log(`[${this.label} StatusCheck] Pausing pipeline, status=${status} (AC_OFF=${AC_STATUS.AC_OFF}, AC_REPLAY=${AC_STATUS.AC_REPLAY})`);
        this.loggedInvalidStatus = true;
      }
      return false;
    }
    if (this.loggedInvalidStatus) {
      console.log(`[${this.label} StatusCheck] Status=${status} — pipeline resuming`);
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
