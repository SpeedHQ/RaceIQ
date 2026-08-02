/**
 * Physics-rate DistanceTraveled derivation.
 *
 * GRAPHICS current_km is authoritative track distance but updates at only 60Hz,
 * while telemetry is stored at ~100Hz. Fill gaps between current_km ticks by
 * integrating speed against the physics packetId, then re-anchor on each tick.
 * The seconds-per-physics-step constant is self-calibrated from raw packet data
 * so replay produces the same result without wall-clock input.
 */

const K_FALLBACK = 1 / 333;
const K_MIN = 1 / 1000;
const K_MAX = 1 / 100;
const K_EMA = 0.2;
const LAP_RESET_M = 50;
const CALIB_MIN_M = 5;
const PACKET_ID_MAX_JUMP = 10000;

export interface AcEvoDistanceState {
  previousPacketId: number;
  previousSpeedMps: number;
  previousCurrentKm: number;
  anchorM: number;
  integralUnit: number;
  calibrationIntegralUnit: number;
  calibrationTrueM: number;
  secondsPerPhysicsStep: number;
  outputM: number;
}

export function createAcEvoDistanceState(): AcEvoDistanceState {
  return {
    previousPacketId: -1,
    previousSpeedMps: 0,
    previousCurrentKm: -1,
    anchorM: 0,
    integralUnit: 0,
    calibrationIntegralUnit: 0,
    calibrationTrueM: 0,
    secondsPerPhysicsStep: 0,
    outputM: 0,
  };
}

/**
 * Derive monotonic per-lap distance in metres from current_km plus physics-rate
 * speed integration. State is owned by caller and reproduces identically on
 * replay for same packetId/speedMps/currentKm sequence.
 */
export function integrateDistance(
  state: AcEvoDistanceState,
  packetId: number,
  speedMps: number,
  currentKm: number,
): number {
  const previousKm = state.previousCurrentKm;
  const currentKmDelta = previousKm < 0 ? 0 : currentKm - previousKm;

  if (previousKm >= 0 && currentKmDelta < -(LAP_RESET_M / 1000)) {
    state.anchorM = currentKm * 1000;
    state.integralUnit = 0;
    state.calibrationIntegralUnit = 0;
    state.calibrationTrueM = 0;
    state.outputM = state.anchorM;
    state.previousPacketId = packetId;
    state.previousSpeedMps = speedMps;
    state.previousCurrentKm = currentKm;
    return state.outputM;
  }

  const packetDelta = state.previousPacketId < 0 ? 0 : packetId - state.previousPacketId;
  if (packetDelta > 0 && packetDelta <= PACKET_ID_MAX_JUMP) {
    const segment = 0.5 * (speedMps + state.previousSpeedMps) * packetDelta;
    state.integralUnit += segment;
    state.calibrationIntegralUnit += segment;
  }

  if (currentKmDelta > 0) {
    state.calibrationTrueM += currentKmDelta * 1000;
    if (state.calibrationIntegralUnit > 0 && state.calibrationTrueM >= CALIB_MIN_M) {
      const sample = Math.min(K_MAX, Math.max(K_MIN, state.calibrationTrueM / state.calibrationIntegralUnit));
      state.secondsPerPhysicsStep =
        state.secondsPerPhysicsStep === 0
          ? sample
          : (1 - K_EMA) * state.secondsPerPhysicsStep + K_EMA * sample;
      state.calibrationTrueM = 0;
      state.calibrationIntegralUnit = 0;
    }
    state.anchorM = currentKm * 1000;
    state.integralUnit = 0;
  }

  const secondsPerStep = state.secondsPerPhysicsStep > 0 ? state.secondsPerPhysicsStep : K_FALLBACK;
  const candidate = previousKm < 0 ? currentKm * 1000 : state.anchorM + secondsPerStep * state.integralUnit;
  state.outputM = Math.max(state.outputM, candidate);
  state.previousPacketId = packetId;
  state.previousSpeedMps = speedMps;
  state.previousCurrentKm = currentKm;
  return state.outputM;
}
