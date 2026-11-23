import { getAccCarByModel } from "@raceiq/game-acc-metadata/racing/cars/acc"
import { getAccTrackByName } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc"
import { trackFrameLocalParserInput } from "@raceiq/backend-core/games/packet-dispatch";
import { processPacket } from "@raceiq/backend-core/telemetry/live-pipeline";
import { ACC_PACKED_MAGIC, packTriplet } from "@raceiq/capture-formats/kunos/pack-triplet";
import type { TripletProcessor } from "@raceiq/backend-core/games/kunos/triplet-pipeline";
import { parseAccBuffers } from "./parser";
import { accBroadcastState, attachAccBroadcastSnapshot } from "@raceiq/capture-formats/acc/broadcast-state";
import { accBroadcastCapture } from "./broadcast-capture";
import { AC_STATUS, GRAPHICS, STATIC } from "@raceiq/capture-formats/acc/structs";
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
  private carId: string;
  private trackId: string;
  private readonly sourceCarId: number;
  private readonly sourceTrackId: number;

  constructor(sourceCarId: number, sourceTrackId: number) {
    this.sourceCarId = sourceCarId;
    this.sourceTrackId = sourceTrackId;
    this.carId = sourceCarId < 0 ? "" : String(sourceCarId);
    this.trackId = sourceTrackId < 0 ? "" : String(sourceTrackId);
  }

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer; frameTimeMs?: number }): Promise<undefined> {
    try {
      if (!this.carId && triplet.staticData.length >= STATIC.SIZE) {
        const cm = readWString(triplet.staticData, STATIC.carModel.offset, STATIC.carModel.size);
        if (cm) this.carId = String(getAccCarByModel(cm)?.id ?? cm);
      }
      if (!this.trackId && triplet.staticData.length >= STATIC.SIZE) {
        const tn = readWString(triplet.staticData, STATIC.track.offset, STATIC.track.size);
        if (tn) this.trackId = String(getAccTrackByName(tn)?.id ?? tn);
      }
      const sourceFrame = packTriplet(
        ACC_PACKED_MAGIC, this.sourceCarId, this.sourceTrackId,
        triplet.physics, triplet.graphics, triplet.staticData,
      );
      const timestampMs = triplet.frameTimeMs ?? Date.now();
      trackFrameLocalParserInput("acc", sourceFrame, timestampMs, true);
      const packet = parseAccBuffers(triplet.physics, triplet.graphics, triplet.staticData, {
        carId: this.carId,
        trackId: this.trackId,
        gameId: "acc",
        timestampMs,
      });
      if (packet) {
        const frameReceivedAtMs = Date.now();
        packet.TimestampMS = frameReceivedAtMs;
        const playerCarIndex = triplet.graphics.length >= GRAPHICS.playerCarID.offset + 4
          ? triplet.graphics.readInt32LE(GRAPHICS.playerCarID.offset)
          : -1;
        accBroadcastState.setPlayerCarIndex(playerCarIndex);
        attachAccBroadcastSnapshot(packet, playerCarIndex, accBroadcastState.snapshot());
        const cursor = accBroadcastCapture.prepare(frameReceivedAtMs);
        await processPacket(packet, {
          frame: sourceFrame,
          capturePrefixRecords: () => [accBroadcastCapture.encode(cursor)],
          captureSessionContextRecords: () => accBroadcastCapture.encodeSessionContext(cursor),
          acknowledgeRecorded: () => accBroadcastCapture.acknowledge(cursor, playerCarIndex),
        }, triplet.frameTimeMs);
      }
    } catch (err) {
      console.error("[ACC ParsingProcessor] Error:", err instanceof Error ? err.message : err);
      throw err;
    }
    return undefined;
  }
}

