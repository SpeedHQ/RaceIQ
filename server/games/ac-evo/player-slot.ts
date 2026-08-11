import { GRAPHICS_EVO, PHYSICS } from "./structs";

const CALIBRATION_FRAMES = 60;
const SPEED_THRESHOLD_KMH = 20;
const MAX_CAR_SLOTS = 60;

export interface PlayerSlotState {
  /** Locked player slot (-1 = not yet identified). */
  slot: number;
  /** Per-slot cosine score accumulators. */
  scores: Float32Array;
  scoredFrames: number;
  /** Previous coordinates per slot [slot * 3 + xyz]. */
  previousCoordinates: Float32Array;
}

export function createPlayerSlotState(): PlayerSlotState {
  return {
    slot: -1,
    scores: new Float32Array(MAX_CAR_SLOTS),
    scoredFrames: 0,
    previousCoordinates: new Float32Array(MAX_CAR_SLOTS * 3),
  };
}

/**
 * Correlate physics velocity direction with per-slot coordinate deltas to
 * identify which car slot is the player's. AC Evo v0.6 exposes no per-slot car
 * ID array, so calibration owns explicit scoring state across frames.
 */
export function calibratePlayerSlot(
  physicsBuf: Buffer,
  graphicsBuf: Buffer,
  state: PlayerSlotState,
  activeCars: number,
): void {
  const speedKmh = physicsBuf.readFloatLE(PHYSICS.speedKmh.offset);
  if (speedKmh < SPEED_THRESHOLD_KMH) return;

  const velocityX = physicsBuf.readFloatLE(PHYSICS.velocityX.offset);
  const velocityZ = physicsBuf.readFloatLE(PHYSICS.velocityZ.offset);
  const velocityMagnitude = Math.sqrt(velocityX * velocityX + velocityZ * velocityZ);
  if (velocityMagnitude < 0.1) return;

  const coordinateBase = GRAPHICS_EVO.car_coordinates_base.offset;
  const slotCount = Math.min(activeCars || 1, MAX_CAR_SLOTS);

  for (let slot = 0; slot < slotCount; slot++) {
    const x = graphicsBuf.readFloatLE(coordinateBase + slot * 12);
    const z = graphicsBuf.readFloatLE(coordinateBase + slot * 12 + 8);
    const previousX = state.previousCoordinates[slot * 3];
    const previousZ = state.previousCoordinates[slot * 3 + 2];

    const deltaX = x - previousX;
    const deltaZ = z - previousZ;
    const deltaMagnitude = Math.sqrt(deltaX * deltaX + deltaZ * deltaZ);

    if (deltaMagnitude > 0.01) {
      const cosine = (velocityX * deltaX + velocityZ * deltaZ) / (velocityMagnitude * deltaMagnitude);
      state.scores[slot] += cosine;
    }

    state.previousCoordinates[slot * 3] = x;
    state.previousCoordinates[slot * 3 + 2] = z;
  }

  state.scoredFrames++;
  if (state.scoredFrames < CALIBRATION_FRAMES) return;

  let bestSlot = 0;
  let bestScore = -Infinity;
  for (let slot = 0; slot < MAX_CAR_SLOTS; slot++) {
    if (state.scores[slot] > bestScore) {
      bestScore = state.scores[slot];
      bestSlot = slot;
    }
  }

  state.slot = bestSlot;
  console.log(`[AC Evo Parser] Player slot locked: ${bestSlot} (score ${bestScore.toFixed(1)} after ${state.scoredFrames} frames)`);
}
