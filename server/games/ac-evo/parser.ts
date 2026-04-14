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
 *
 * Known AC Evo v0.5 limitations (lap detection not possible until fixed upstream):
 *   - completedLaps, iCurrentTime, normalizedCarPosition, distanceTraveled all zero
 */

import { parseAccBuffers } from "../acc/parser";
import { STATIC, GRAPHICS, PHYSICS } from "../acc/structs";
import { readWString } from "../acc/utils";
import { getAcEvoCarByDisplayName } from "../../../shared/ac-evo-car-data";
import { getAcEvoTrackByName } from "../../../shared/ac-evo-track-data";
import type { TelemetryPacket } from "../../../shared/types";

const SLOT_CALIBRATION_FRAMES = 60; // frames of movement needed to lock in player slot
const SPEED_THRESHOLD_KMH = 20;     // only score slots when car is actually moving

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

  // Calibrate player slot if not yet locked
  if (cache.playerSlot === -1) {
    calibratePlayerSlot(physicsBuf, graphicsBuf, cache);
  }

  // Read normalizedCarPosition from graphics — used for track map
  // Same offset as ACC (248)
  const normalizedCarPos = graphicsBuf.readFloatLE(GRAPHICS.normalizedCarPosition.offset);

  const packet = parseAccBuffers(physicsBuf, graphicsBuf, staticBuf, {
    carOrdinal: cache.carOrdinal,
    trackOrdinal: cache.trackOrdinal,
    gameId: "ac-evo",
    playerSlot: cache.playerSlot === -1 ? undefined : cache.playerSlot,
  });

  if (packet && packet.acc) {
    (packet.acc as any).normalizedCarPosition = normalizedCarPos;
  }

  return packet;
}

/** Mutable cache object passed into parseAcEvoBuffers to avoid repeated lookups. */
export interface AcEvoParserCache {
  carOrdinal: number;
  trackOrdinal: number;
  lastCarModel: string;
  lastTrack: string;
  /** Locked player slot (-1 = not yet identified) */
  playerSlot: number;
  /** Per-slot cosine score accumulators for slot calibration */
  _slotScores: Float32Array;
  /** Number of scored frames so far */
  _scoredFrames: number;
  /** Previous graphics coordinates per slot for delta computation [slot][xyz] */
  _prevCoords: Float32Array;
}

export function createAcEvoParserCache(): AcEvoParserCache {
  return {
    carOrdinal: 0,
    trackOrdinal: 0,
    lastCarModel: "",
    lastTrack: "",
    playerSlot: -1,
    _slotScores: new Float32Array(60),
    _scoredFrames: 0,
    _prevCoords: new Float32Array(60 * 3),
  };
}

/**
 * Identify the player slot by correlating physics velocity direction with
 * coordinate deltas across slots. Called each frame until the slot is locked.
 */
function calibratePlayerSlot(
  physicsBuf: Buffer,
  graphicsBuf: Buffer,
  cache: AcEvoParserCache,
): void {
  const speedKmh = physicsBuf.readFloatLE(PHYSICS.speedKmh.offset);
  if (speedKmh < SPEED_THRESHOLD_KMH) return;

  const velX = physicsBuf.readFloatLE(PHYSICS.velocityX.offset);
  const velZ = physicsBuf.readFloatLE(PHYSICS.velocityZ.offset);
  const velMag = Math.sqrt(velX * velX + velZ * velZ);
  if (velMag < 0.1) return;

  const activeCars = graphicsBuf.readInt32LE(GRAPHICS.activeCars.offset);
  const coordBase = GRAPHICS.carCoordinatesBase.offset;

  for (let i = 0; i < Math.min(activeCars, 60); i++) {
    const x = graphicsBuf.readFloatLE(coordBase + i * 12);
    const z = graphicsBuf.readFloatLE(coordBase + i * 12 + 8);
    const prevX = cache._prevCoords[i * 3];
    const prevZ = cache._prevCoords[i * 3 + 2];

    const dx = x - prevX;
    const dz = z - prevZ;
    const dMag = Math.sqrt(dx * dx + dz * dz);

    if (dMag > 0.01) {
      // Cosine similarity between velocity and coordinate delta
      const cosine = (velX * dx + velZ * dz) / (velMag * dMag);
      cache._slotScores[i] += cosine;
    }

    cache._prevCoords[i * 3] = x;
    cache._prevCoords[i * 3 + 2] = z;
  }

  cache._scoredFrames++;

  if (cache._scoredFrames >= SLOT_CALIBRATION_FRAMES) {
    let bestSlot = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < 60; i++) {
      if (cache._slotScores[i] > bestScore) {
        bestScore = cache._slotScores[i];
        bestSlot = i;
      }
    }
    cache.playerSlot = bestSlot;
    console.log(`[AC Evo Parser] Player slot locked: ${bestSlot} (score ${bestScore.toFixed(1)} after ${cache._scoredFrames} frames)`);
  }
}
