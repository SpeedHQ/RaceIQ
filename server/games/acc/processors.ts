import { getAccCarByModel } from "../../../shared/racing/cars/acc"
import { getAccTrackByName } from "../../../shared/racing/tracks/catalogs/acc"
import { processPacket } from "../../telemetry/live-pipeline";
import { ACC_PACKED_MAGIC, packTriplet } from "../kunos/pack-triplet";
import type { TripletProcessor } from "../kunos/triplet-pipeline";
import { parseAccBuffers } from "./parser";
import { AC_STATUS, GRAPHICS, STATIC } from "./structs";
import { readWString } from "./utils";

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
  private carOrdinal: number;
  private trackOrdinal: number;

  constructor(
    carOrdinal: number,
    trackOrdinal: number,
  ) {
    this.carOrdinal = carOrdinal;
    this.trackOrdinal = trackOrdinal;
  }

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<void> {
    try {
      if (this.carOrdinal === -1 && triplet.staticData.length >= STATIC.SIZE) {
        const cm = readWString(triplet.staticData, STATIC.carModel.offset, STATIC.carModel.size);
        if (cm) this.carOrdinal = getAccCarByModel(cm)?.id ?? -1;
      }
      if (this.trackOrdinal === -1 && triplet.staticData.length >= STATIC.SIZE) {
        const tn = readWString(triplet.staticData, STATIC.track.offset, STATIC.track.size);
        if (tn) this.trackOrdinal = getAccTrackByName(tn)?.id ?? -1;
      }
      const packet = parseAccBuffers(triplet.physics, triplet.graphics, triplet.staticData, {
        carOrdinal: this.carOrdinal,
        trackOrdinal: this.trackOrdinal,
        gameId: "acc",
      });
      if (packet) {
        const sourceFrame = packTriplet(ACC_PACKED_MAGIC, this.carOrdinal, this.trackOrdinal, triplet.physics, triplet.graphics, triplet.staticData);
        await processPacket(packet, sourceFrame);
      }
    } catch (err) {
      console.error("[ACC ParsingProcessor] Error:", err instanceof Error ? err.message : err);
      throw err;
    }
  }
}
