import { processPacket } from "../../telemetry/live-pipeline";
import { ACC_PACKED_MAGIC, packTriplet } from "../kunos/pack-triplet";
import type { TripletProcessor } from "../kunos/triplet-pipeline";
import { parseAccBuffers } from "./parser";
import { AC_STATUS, GRAPHICS } from "./structs";

/** Gates triplet processing while ACC is outside a live or paused session. */
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

/** Parses ACC buffers and feeds normalized packets to the application pipeline. */
export class ParsingProcessor implements TripletProcessor {

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<undefined> {
    try {
      const packet = parseAccBuffers(triplet.physics, triplet.graphics, triplet.staticData);
      if (packet) {
        const sourceFrame = packTriplet(ACC_PACKED_MAGIC, -1, -1, triplet.physics, triplet.graphics, triplet.staticData);
        await processPacket(packet, sourceFrame);
      }
    } catch (err) {
      console.error("[ACC ParsingProcessor] Error:", err instanceof Error ? err.message : err);
      throw err;
    }
    return undefined;
  }
}
