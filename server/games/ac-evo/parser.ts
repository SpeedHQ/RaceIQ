/**
 * AC Evo parser: wraps the ACC shared memory parser with AC Evo-specific
 * car/track name resolution.
 *
 * AC Evo uses the same shared memory struct layout as ACC but populates the
 * STATIC carModel and track fields with display names rather than internal IDs
 * (e.g. "Porsche 911 GT3 Cup (992)" instead of "porsche_911_gt3_cup_992").
 *
 * Offsets that differ from ACC will be noted here as they're discovered during
 * early access. Physics struct is confirmed identical.
 */

import { parseAccBuffers } from "../acc/parser";
import { STATIC, GRAPHICS } from "../acc/structs";
import { readWString } from "../acc/utils";
import { getAcEvoCarByDisplayName } from "../../../shared/ac-evo-car-data";
import { getAcEvoTrackByName } from "../../../shared/ac-evo-track-data";
import type { TelemetryPacket } from "../../../shared/types";

export function parseAcEvoBuffers(
  physicsBuf: Buffer,
  graphicsBuf: Buffer,
  staticBuf: Buffer,
  cache: AcEvoParserCache,
): TelemetryPacket | null {
  // Read display names from STATIC — same offsets as ACC
  const carModelStr = readWString(staticBuf, STATIC.carModel.offset, STATIC.carModel.size);
  const trackStr = readWString(staticBuf, STATIC.track.offset, STATIC.track.size);

  // Resolve ordinals (cached — only re-lookup when the value changes)
  if (carModelStr && carModelStr !== cache.lastCarModel) {
    cache.lastCarModel = carModelStr;
    const car = getAcEvoCarByDisplayName(carModelStr);
    if (car) {
      cache.carOrdinal = car.id;
      console.log(`[AC Evo Parser] Resolved car: "${carModelStr}" → ordinal ${car.id}`);
    } else {
      cache.carOrdinal = 0;
      console.warn(`[AC Evo Parser] Unknown car display name: "${carModelStr}"`);
    }
  }

  if (trackStr && trackStr !== cache.lastTrack) {
    cache.lastTrack = trackStr;
    const track = getAcEvoTrackByName(trackStr);
    if (track) {
      cache.trackOrdinal = track.id;
      console.log(`[AC Evo Parser] Resolved track: "${trackStr}" → ordinal ${track.id}`);
    } else {
      cache.trackOrdinal = 0;
      console.warn(`[AC Evo Parser] Unknown track name: "${trackStr}"`);
    }
  }

  // Read normalizedCarPosition from graphics — used for track map
  // Same offset as ACC (248)
  const normalizedCarPos = graphicsBuf.readFloatLE(GRAPHICS.normalizedCarPosition.offset);

  const packet = parseAccBuffers(physicsBuf, graphicsBuf, staticBuf, {
    carOrdinal: cache.carOrdinal,
    trackOrdinal: cache.trackOrdinal,
    gameId: "ac-evo",
  });

  if (packet) {
    // AC Evo may not populate STATIC maxRpm — fall back to physics currentMaxRpm
    // which is already handled in parseAccBuffers (EngineMaxRpm: currentMaxRpm || maxRpm)

    // Attach normalized car position for track map (not in base TelemetryPacket,
    // stored in acc extended data)
    if (packet.acc) {
      (packet.acc as any).normalizedCarPosition = normalizedCarPos;
    }
  }

  return packet;
}

/** Mutable cache object passed into parseAcEvoBuffers to avoid repeated lookups. */
export interface AcEvoParserCache {
  carOrdinal: number;
  trackOrdinal: number;
  lastCarModel: string;
  lastTrack: string;
}

export function createAcEvoParserCache(): AcEvoParserCache {
  return { carOrdinal: 0, trackOrdinal: 0, lastCarModel: "", lastTrack: "" };
}
