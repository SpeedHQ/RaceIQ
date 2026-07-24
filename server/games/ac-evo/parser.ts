/**
 * AC Evo v0.6 parser: reads from SPageFilePhysics, SPageFileGraphicEvo, and
 * SPageFileStaticEvo directly (no longer routed through the ACC parser).
 *
 * Diverges from ACC: graphics layout is completely different, and identifiers
 * live in different pages:
 *   - car model: GRAPHICS_EVO.car_model (char[33])
 *   - track:     STATIC_EVO.track (char[33])
 *   - driver:    GRAPHICS_EVO.driver_name / driver_surname
 */

import type { TelemetryPacket, AccExtendedData, AcEvoExtendedData, GameId } from "../../../shared/types";
import {
  PHYSICS,
  GRAPHICS_EVO,
  STATIC_EVO,
  SESSION_STATE,
  TIMING_STATE,
  ELECTRONICS,
  ACEVO_STATUS,
  ACEVO_FLAG_NAMES,
  ACEVO_CAR_LOCATION,
  ACEVO_SESSION_TYPE_NAMES,
  ACEVO_STARTING_GRIP_NAMES,
} from "./structs";
import { readCString } from "./utils";
import { getAcEvoCarByDisplayName } from "../../../shared/ac-evo-car-data";
import { getAcEvoTrackByName } from "../../../shared/ac-evo-track-data";

const SLOT_CALIBRATION_FRAMES = 60;
const SPEED_THRESHOLD_KMH = 20;

// --- Physics-rate DistanceTraveled derivation (integrateDistance) ---
// GRAPHICS current_km is authoritative track distance but updates at only 60Hz,
// while telemetry is stored at ~100Hz — so ~40% of frames would share a
// duplicate distance and stack on distance-keyed charts. We fill the gaps
// between current_km ticks by integrating speed against the physics `packetId`
// (which ticks every physics step, far faster than 100Hz), then re-anchor to
// current_km on each tick so integration error never accumulates. The unknown
// seconds-per-physics-step constant `k` is self-calibrated from the ratio of
// each current_km delta to the speed·packetId integral over that interval — no
// hardcoded physics rate. Must be reproducible from raw buffers alone (runs on
// replay), so it depends only on packetId/speed/current_km, never a wall clock.
const DIST_K_FALLBACK = 1 / 333; // seconds per physics step, pre-calibration only
const DIST_K_MIN = 1 / 1000;
const DIST_K_MAX = 1 / 100;
const DIST_K_EMA = 0.2; // smoothing for calibrated-k updates
const DIST_LAP_RESET_M = 50; // current_km drop beyond this (m) ⇒ new lap
const DIST_CALIB_MIN_M = 5; // require ≥5 m true travel before trusting a k sample
const DIST_PACKETID_MAX_JUMP = 10000; // ΔpacketId above this ⇒ discontinuity, skip

export interface AcEvoParserCache {
  carOrdinal: number;
  trackOrdinal: number;
  lastCarModel: string;
  lastTrack: string;
  /** Locked player slot (-1 = not yet identified) */
  playerSlot: number;
  /** Per-slot cosine score accumulators */
  _slotScores: Float32Array;
  _scoredFrames: number;
  /** Previous coords per slot [slot*3 + xyz] */
  _prevCoords: Float32Array;

  // Physics-rate DistanceTraveled integration state (see integrateDistance).
  _distPrevPacketId: number; // last physics packetId (-1 = none)
  _distPrevSpeedMps: number; // last speed m/s (trapezoidal integration)
  _distPrevCurrentKm: number; // last current_km (-1 = none)
  _distAnchorM: number; // ground-truth distance (m) at last current_km tick
  _distIntegralUnit: number; // Σ 0.5*(v+vPrev)*ΔpacketId since last anchor
  _distCalibIntegralUnit: number; // same, over the current calibration window
  _distCalibTrueM: number; // Σ true metres (current_km deltas) over that window
  _distK: number; // seconds per physics step (calibrated); 0 = uncalibrated
  _distOut: number; // last emitted DistanceTraveled (m), monotonic clamp
}

export function createAcEvoParserCache(): AcEvoParserCache {
  return {
    // -1 = not yet identified. Ordinal 0 is a real car (Ferrari SF90 Stradale)
    // and a real track (Monza GP), so an empty/unknown name must NOT default
    // to 0 — that is exactly the production bug where sessions imported as
    // "Monza" / "Ferrari SF90 Stradale".
    carOrdinal: -1,
    trackOrdinal: -1,
    lastCarModel: "",
    lastTrack: "",
    playerSlot: -1,
    _slotScores: new Float32Array(60),
    _scoredFrames: 0,
    _prevCoords: new Float32Array(60 * 3),
    _distPrevPacketId: -1,
    _distPrevSpeedMps: 0,
    _distPrevCurrentKm: -1,
    _distAnchorM: 0,
    _distIntegralUnit: 0,
    _distCalibIntegralUnit: 0,
    _distCalibTrueM: 0,
    _distK: 0,
    _distOut: 0,
  };
}

/**
 * Derive a physics-rate, monotonic, per-lap DistanceTraveled (metres) from the
 * 60Hz `current_km` anchor plus speed integrated against the physics `packetId`
 * clock. See the DIST_* constants above for the rationale. Pure w.r.t. the raw
 * inputs (packetId/speedMps/currentKm) so it reproduces identically on replay.
 */
function integrateDistance(
  cache: AcEvoParserCache,
  packetId: number,
  speedMps: number,
  currentKm: number,
): number {
  const prevKm = cache._distPrevCurrentKm;
  const dCurrentKm = prevKm < 0 ? 0 : currentKm - prevKm;

  // Lap reset: current_km resets to ~0 at each new lap. Snap to the fresh
  // anchor and clear accumulators, but keep the calibrated k across laps.
  if (prevKm >= 0 && dCurrentKm < -(DIST_LAP_RESET_M / 1000)) {
    cache._distAnchorM = currentKm * 1000;
    cache._distIntegralUnit = 0;
    cache._distCalibIntegralUnit = 0;
    cache._distCalibTrueM = 0;
    cache._distOut = cache._distAnchorM;
    cache._distPrevPacketId = packetId;
    cache._distPrevSpeedMps = speedMps;
    cache._distPrevCurrentKm = currentKm;
    return cache._distOut;
  }

  // Integrate speed against packetId ticks (guard duplicate/backward/wrapped).
  const dP = cache._distPrevPacketId < 0 ? 0 : packetId - cache._distPrevPacketId;
  if (dP > 0 && dP <= DIST_PACKETID_MAX_JUMP) {
    const seg = 0.5 * (speedMps + cache._distPrevSpeedMps) * dP;
    cache._distIntegralUnit += seg;
    cache._distCalibIntegralUnit += seg;
  }

  // A graphics tick landed: re-anchor to ground-truth current_km every tick so
  // integration error can't accumulate. Calibration accumulates ACROSS ticks —
  // a single 60Hz interval is under a metre, far below the noise floor, so k is
  // only updated once the window has covered DIST_CALIB_MIN_M of real travel.
  if (dCurrentKm > 0) {
    cache._distCalibTrueM += dCurrentKm * 1000;
    if (cache._distCalibIntegralUnit > 0 && cache._distCalibTrueM >= DIST_CALIB_MIN_M) {
      const kSample = Math.min(DIST_K_MAX, Math.max(DIST_K_MIN, cache._distCalibTrueM / cache._distCalibIntegralUnit));
      cache._distK = cache._distK === 0 ? kSample : (1 - DIST_K_EMA) * cache._distK + DIST_K_EMA * kSample;
      cache._distCalibTrueM = 0;
      cache._distCalibIntegralUnit = 0;
    }
    cache._distAnchorM = currentKm * 1000;
    cache._distIntegralUnit = 0;
  }

  const k = cache._distK > 0 ? cache._distK : DIST_K_FALLBACK;
  const candidate = prevKm < 0 ? currentKm * 1000 : cache._distAnchorM + k * cache._distIntegralUnit;
  // Monotonic non-decreasing within a lap (a re-anchor may nudge backward).
  cache._distOut = Math.max(cache._distOut, candidate);
  cache._distPrevPacketId = packetId;
  cache._distPrevSpeedMps = speedMps;
  cache._distPrevCurrentKm = currentKm;
  return cache._distOut;
}

export function parseAcEvoBuffers(
  physicsBuf: Buffer,
  graphicsBuf: Buffer,
  staticBuf: Buffer,
  cache: AcEvoParserCache,
): TelemetryPacket | null {
  if (
    physicsBuf.length < PHYSICS.SIZE ||
    graphicsBuf.length < GRAPHICS_EVO.SIZE ||
    staticBuf.length < STATIC_EVO.SIZE
  ) {
    return null;
  }

  // --- Identify car/track ---
  // v0.6 puts car_model inside GRAPHICS_EVO, track inside STATIC_EVO
  const carModelStr = readCString(graphicsBuf, GRAPHICS_EVO.car_model.offset, GRAPHICS_EVO.car_model.size);
  const trackStr = readCString(staticBuf, STATIC_EVO.track.offset, STATIC_EVO.track.size);
  const trackCfgStr = readCString(staticBuf, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size);

  if (carModelStr && carModelStr !== cache.lastCarModel) {
    cache.lastCarModel = carModelStr;
    const car = getAcEvoCarByDisplayName(carModelStr);
    if (car) {
      cache.carOrdinal = car.id;
      console.log(`[AC Evo Parser] Resolved car: "${carModelStr}" → ordinal ${car.id}`);
    } else {
      cache.carOrdinal = -1;
      console.warn(`[AC Evo Parser] Unknown car "${carModelStr}" — add it to shared/games/ac-evo/cars.csv`);
    }
  }

  // Include the layout in the cache key: switching GP → Indy at the same
  // circuit changes only track_configuration, not track.
  const trackKey = `${trackStr}|${trackCfgStr}`;
  if (trackStr && trackKey !== cache.lastTrack) {
    cache.lastTrack = trackKey;
    const track = getAcEvoTrackByName(trackStr, trackCfgStr);
    if (track) {
      cache.trackOrdinal = track.id;
      console.log(`[AC Evo Parser] Resolved track: "${trackStr}" (config "${trackCfgStr}") → ordinal ${track.id} (${track.name} - ${track.variant})`);
    } else {
      cache.trackOrdinal = -1;
      console.warn(`[AC Evo Parser] Unknown track name: "${trackStr}" (config "${trackCfgStr}")`);
    }
  }

  // --- Physics ---
  const gas = physicsBuf.readFloatLE(PHYSICS.gas.offset);
  const brake = physicsBuf.readFloatLE(PHYSICS.brake.offset);
  const fuel = physicsBuf.readFloatLE(PHYSICS.fuel.offset);
  const accGear = physicsBuf.readInt32LE(PHYSICS.gear.offset);
  const rpms = physicsBuf.readInt32LE(PHYSICS.rpms.offset);
  const steerAngle = physicsBuf.readFloatLE(PHYSICS.steerAngle.offset);
  const speedKmh = physicsBuf.readFloatLE(PHYSICS.speedKmh.offset);
  const physPacketId = physicsBuf.readInt32LE(PHYSICS.packetId.offset);

  const velX = physicsBuf.readFloatLE(PHYSICS.velocityX.offset);
  const velY = physicsBuf.readFloatLE(PHYSICS.velocityY.offset);
  const velZ = physicsBuf.readFloatLE(PHYSICS.velocityZ.offset);
  const angVelX = physicsBuf.readFloatLE(PHYSICS.localAngularVelX.offset);
  const angVelY = physicsBuf.readFloatLE(PHYSICS.localAngularVelY.offset);
  const angVelZ = physicsBuf.readFloatLE(PHYSICS.localAngularVelZ.offset);
  const gX = physicsBuf.readFloatLE(PHYSICS.accGX.offset);
  const gY = physicsBuf.readFloatLE(PHYSICS.accGY.offset);
  const gZ = physicsBuf.readFloatLE(PHYSICS.accGZ.offset);

  const heading = physicsBuf.readFloatLE(PHYSICS.heading.offset);
  const pitch = physicsBuf.readFloatLE(PHYSICS.pitch.offset);
  const roll = physicsBuf.readFloatLE(PHYSICS.roll.offset);

  const pressFL = physicsBuf.readFloatLE(PHYSICS.tyrePressureFL.offset);
  const pressFR = physicsBuf.readFloatLE(PHYSICS.tyrePressureFR.offset);
  const pressRL = physicsBuf.readFloatLE(PHYSICS.tyrePressureRL.offset);
  const pressRR = physicsBuf.readFloatLE(PHYSICS.tyrePressureRR.offset);

  const coreFL = physicsBuf.readFloatLE(PHYSICS.tyreCoreFL.offset);
  const coreFR = physicsBuf.readFloatLE(PHYSICS.tyreCoreFR.offset);
  const coreRL = physicsBuf.readFloatLE(PHYSICS.tyreCoreRL.offset);
  const coreRR = physicsBuf.readFloatLE(PHYSICS.tyreCoreRR.offset);

  const tempFL = physicsBuf.readFloatLE(PHYSICS.tyreTempFL.offset);
  const tempFR = physicsBuf.readFloatLE(PHYSICS.tyreTempFR.offset);
  const tempRL = physicsBuf.readFloatLE(PHYSICS.tyreTempRL.offset);
  const tempRR = physicsBuf.readFloatLE(PHYSICS.tyreTempRR.offset);

  const innerFL = physicsBuf.readFloatLE(PHYSICS.tyreTempInnerFL.offset);
  const innerFR = physicsBuf.readFloatLE(PHYSICS.tyreTempInnerFR.offset);
  const innerRL = physicsBuf.readFloatLE(PHYSICS.tyreTempInnerRL.offset);
  const innerRR = physicsBuf.readFloatLE(PHYSICS.tyreTempInnerRR.offset);
  const outerFL = physicsBuf.readFloatLE(PHYSICS.tyreTempOuterFL.offset);
  const outerFR = physicsBuf.readFloatLE(PHYSICS.tyreTempOuterFR.offset);
  const outerRL = physicsBuf.readFloatLE(PHYSICS.tyreTempOuterRL.offset);
  const outerRR = physicsBuf.readFloatLE(PHYSICS.tyreTempOuterRR.offset);

  const camberFL = physicsBuf.readFloatLE(PHYSICS.camberFL.offset);
  const camberFR = physicsBuf.readFloatLE(PHYSICS.camberFR.offset);
  const camberRL = physicsBuf.readFloatLE(PHYSICS.camberRL.offset);
  const camberRR = physicsBuf.readFloatLE(PHYSICS.camberRR.offset);

  const chBase = PHYSICS.contactHeadingBase.offset;
  const contactHeading: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ] = [
    [physicsBuf.readFloatLE(chBase), physicsBuf.readFloatLE(chBase + 4), physicsBuf.readFloatLE(chBase + 8)],
    [physicsBuf.readFloatLE(chBase + 12), physicsBuf.readFloatLE(chBase + 16), physicsBuf.readFloatLE(chBase + 20)],
    [physicsBuf.readFloatLE(chBase + 24), physicsBuf.readFloatLE(chBase + 28), physicsBuf.readFloatLE(chBase + 32)],
    [physicsBuf.readFloatLE(chBase + 36), physicsBuf.readFloatLE(chBase + 40), physicsBuf.readFloatLE(chBase + 44)],
  ];

  const wearFL = physicsBuf.readFloatLE(PHYSICS.tyreWearFL.offset);
  const wearFR = physicsBuf.readFloatLE(PHYSICS.tyreWearFR.offset);
  const wearRL = physicsBuf.readFloatLE(PHYSICS.tyreWearRL.offset);
  const wearRR = physicsBuf.readFloatLE(PHYSICS.tyreWearRR.offset);

  const brTempFL = physicsBuf.readFloatLE(PHYSICS.brakeTempFL.offset);
  const brTempFR = physicsBuf.readFloatLE(PHYSICS.brakeTempFR.offset);
  const brTempRL = physicsBuf.readFloatLE(PHYSICS.brakeTempRL.offset);
  const brTempRR = physicsBuf.readFloatLE(PHYSICS.brakeTempRR.offset);

  const padFL = physicsBuf.readFloatLE(PHYSICS.padLifeFL.offset);
  const padFR = physicsBuf.readFloatLE(PHYSICS.padLifeFR.offset);
  const padRL = physicsBuf.readFloatLE(PHYSICS.padLifeRL.offset);
  const padRR = physicsBuf.readFloatLE(PHYSICS.padLifeRR.offset);

  const suspFL = physicsBuf.readFloatLE(PHYSICS.suspTravelFL.offset);
  const suspFR = physicsBuf.readFloatLE(PHYSICS.suspTravelFR.offset);
  const suspRL = physicsBuf.readFloatLE(PHYSICS.suspTravelRL.offset);
  const suspRR = physicsBuf.readFloatLE(PHYSICS.suspTravelRR.offset);

  const loadFL = physicsBuf.readFloatLE(PHYSICS.wheelLoadFL.offset);
  const loadFR = physicsBuf.readFloatLE(PHYSICS.wheelLoadFR.offset);
  const loadRL = physicsBuf.readFloatLE(PHYSICS.wheelLoadRL.offset);
  const loadRR = physicsBuf.readFloatLE(PHYSICS.wheelLoadRR.offset);
  const cgHeight = physicsBuf.readFloatLE(PHYSICS.cgHeight.offset);

  const middleFL = physicsBuf.readFloatLE(PHYSICS.tyreTempMiddleFL.offset);
  const middleFR = physicsBuf.readFloatLE(PHYSICS.tyreTempMiddleFR.offset);
  const middleRL = physicsBuf.readFloatLE(PHYSICS.tyreTempMiddleRL.offset);
  const middleRR = physicsBuf.readFloatLE(PHYSICS.tyreTempMiddleRR.offset);

  const combinedSlipFL = physicsBuf.readFloatLE(PHYSICS.wheelSlipFL.offset);
  const combinedSlipFR = physicsBuf.readFloatLE(PHYSICS.wheelSlipFR.offset);
  const combinedSlipRL = physicsBuf.readFloatLE(PHYSICS.wheelSlipRL.offset);
  const combinedSlipRR = physicsBuf.readFloatLE(PHYSICS.wheelSlipRR.offset);
  const slipRatioFL = physicsBuf.readFloatLE(PHYSICS.slipRatioFL.offset);
  const slipRatioFR = physicsBuf.readFloatLE(PHYSICS.slipRatioFR.offset);
  const slipRatioRL = physicsBuf.readFloatLE(PHYSICS.slipRatioRL.offset);
  const slipRatioRR = physicsBuf.readFloatLE(PHYSICS.slipRatioRR.offset);
  const slipAngleFL = physicsBuf.readFloatLE(PHYSICS.slipAngleFL.offset);
  const slipAngleFR = physicsBuf.readFloatLE(PHYSICS.slipAngleFR.offset);
  const slipAngleRL = physicsBuf.readFloatLE(PHYSICS.slipAngleRL.offset);
  const slipAngleRR = physicsBuf.readFloatLE(PHYSICS.slipAngleRR.offset);
  const rotFL = physicsBuf.readFloatLE(PHYSICS.wheelRotFL.offset);
  const rotFR = physicsBuf.readFloatLE(PHYSICS.wheelRotFR.offset);
  const rotRL = physicsBuf.readFloatLE(PHYSICS.wheelRotRL.offset);
  const rotRR = physicsBuf.readFloatLE(PHYSICS.wheelRotRR.offset);

  const damFront = physicsBuf.readFloatLE(PHYSICS.damFront.offset);
  const damRear = physicsBuf.readFloatLE(PHYSICS.damRear.offset);
  const damLeft = physicsBuf.readFloatLE(PHYSICS.damLeft.offset);
  const damRight = physicsBuf.readFloatLE(PHYSICS.damRight.offset);
  const damCentre = physicsBuf.readFloatLE(PHYSICS.damCentre.offset);

  const tcFloat = physicsBuf.readFloatLE(PHYSICS.tc.offset);
  const absFloat = physicsBuf.readFloatLE(PHYSICS.abs.offset);
  const slipVib = physicsBuf.readFloatLE(PHYSICS.slipVibrations.offset);
  const absVib = physicsBuf.readFloatLE(PHYSICS.absVibrations.offset);
  const brakeBias = physicsBuf.readFloatLE(PHYSICS.brakeBias.offset);
  const currentMaxRpm = physicsBuf.readInt32LE(PHYSICS.currentMaxRpm.offset);

  // --- Graphics (v0.6) ---
  const status = graphicsBuf.readInt32LE(GRAPHICS_EVO.status.offset);

  // Gate out menu / replay frames. Pause (AC_PAUSE) still emits so the detector
  // keeps `_lastActivePacketTime` fresh and doesn't falsely mark a paused
  // session as stale. Only hard-exit to main menu (AC_OFF) or replay viewer
  // (AC_REPLAY) is treated as session-over.
  if (status === ACEVO_STATUS.AC_OFF || status === ACEVO_STATUS.AC_REPLAY) {
    return null;
  }
  const completedLaps = graphicsBuf.readInt32LE(GRAPHICS_EVO.total_lap_count.offset);
  const position = graphicsBuf.readUInt32LE(GRAPHICS_EVO.current_pos.offset);
  const iCurrentTime = graphicsBuf.readInt32LE(GRAPHICS_EVO.current_lap_time_ms.offset);
  const iLastTime = graphicsBuf.readInt32LE(GRAPHICS_EVO.last_laptime_ms.offset);
  const iBestTime = graphicsBuf.readInt32LE(GRAPHICS_EVO.best_laptime_ms.offset);
  const currentKm = graphicsBuf.readFloatLE(GRAPHICS_EVO.current_km.offset);
  const normalizedCarPos = graphicsBuf.readFloatLE(GRAPHICS_EVO.npos.offset);
  const carLocation = graphicsBuf.readInt32LE(GRAPHICS_EVO.car_location.offset);
  const flagRaw = graphicsBuf.readInt32LE(GRAPHICS_EVO.flag.offset);
  const isInPitBox = graphicsBuf.readUInt8(GRAPHICS_EVO.is_in_pit_box.offset);
  const isInPitLane = graphicsBuf.readUInt8(GRAPHICS_EVO.is_in_pit_lane.offset);
  const isValidLap = graphicsBuf.readUInt8(GRAPHICS_EVO.is_valid_lap.offset);
  const activeCars = graphicsBuf.readUInt8(GRAPHICS_EVO.active_cars.offset);

  const tcActiveBool = graphicsBuf.readUInt8(GRAPHICS_EVO.tc_active.offset);
  const absActiveBool = graphicsBuf.readUInt8(GRAPHICS_EVO.abs_active.offset);
  const tcActive = tcActiveBool || tcFloat > 0.01 || slipVib > 0.01 ? 1 : 0;
  const absActive = absActiveBool || absFloat > 0.01 || absVib > 0.01 ? 1 : 0;

  // Electronics (setting-level integers) — from embedded Electronics sub-struct
  const elecBase = GRAPHICS_EVO.electronics_base.offset;
  const tcLevel = graphicsBuf.readInt8(elecBase + 0);     // tc_level
  const tcCutLevel = graphicsBuf.readInt8(elecBase + 1);  // tc_cut_level
  const absLevel = graphicsBuf.readInt8(elecBase + 2);    // abs_level
  const engineMapLevel = graphicsBuf.readInt8(elecBase + 12); // engine_map_level

  // Tyre compound from front-left tyre state (FL and FR share tyre_compound_front)
  const tyreLfBase = GRAPHICS_EVO.tyre_lf_base.offset;
  const tyreCompound = readCString(graphicsBuf, tyreLfBase + 36, 33);

  // Fuel projection
  const fuelPerLap = graphicsBuf.readFloatLE(GRAPHICS_EVO.fuel_per_lap.offset);

  // Player slot calibration (same velocity-correlation technique)
  if (cache.playerSlot === -1) {
    calibratePlayerSlot(physicsBuf, graphicsBuf, cache, activeCars);
  }
  const playerSlot = cache.playerSlot === -1 ? 0 : cache.playerSlot;
  const coordBase = GRAPHICS_EVO.car_coordinates_base.offset;
  const carX = graphicsBuf.readFloatLE(coordBase + playerSlot * 12);
  const carY = graphicsBuf.readFloatLE(coordBase + playerSlot * 12 + 4);
  const carZ = graphicsBuf.readFloatLE(coordBase + playerSlot * 12 + 8);

  // --- Static (v0.6) ---
  const startingAmbient = staticBuf.readFloatLE(STATIC_EVO.starting_ambient_temperature_c.offset);
  const startingGround = staticBuf.readFloatLE(STATIC_EVO.starting_ground_temperature_c.offset);
  const trackLengthM = staticBuf.readFloatLE(STATIC_EVO.track_length_m.offset);

  // --- AC Evo extended telemetry (previously-ignored shm fields) ---
  const sessionRaw = staticBuf.readInt32LE(STATIC_EVO.session.offset);
  const startingGripRaw = staticBuf.readInt32LE(STATIC_EVO.starting_grip.offset);
  const sessBase = GRAPHICS_EVO.session_state_base.offset;
  const timBase = GRAPHICS_EVO.timing_state_base.offset;

  const acEvoExt: AcEvoExtendedData = {
    physicsPacketId: physPacketId,
    graphicsPacketId: graphicsBuf.readInt32LE(GRAPHICS_EVO.packetId.offset),
    acEvoVersion: readCString(staticBuf, STATIC_EVO.ac_evo_version.offset, STATIC_EVO.ac_evo_version.size),

    sessionType: ACEVO_SESSION_TYPE_NAMES[sessionRaw] ?? "unknown",
    sessionName: readCString(staticBuf, STATIC_EVO.session_name.offset, STATIC_EVO.session_name.size),
    startingGrip: ACEVO_STARTING_GRIP_NAMES[startingGripRaw] ?? "unknown",
    isStaticWeather: staticBuf.readUInt8(STATIC_EVO.is_static_weather.offset) !== 0,
    isTimedRace: staticBuf.readUInt8(STATIC_EVO.is_timed_race.offset) !== 0,
    isOnline: staticBuf.readUInt8(STATIC_EVO.is_online.offset) !== 0,
    numberOfSessions: staticBuf.readInt32LE(STATIC_EVO.number_of_sessions.offset),

    airTempC: physicsBuf.readFloatLE(PHYSICS.airTemp.offset),
    roadTempC: physicsBuf.readFloatLE(PHYSICS.roadTemp.offset),

    deltaTimeMs: graphicsBuf.readInt32LE(GRAPHICS_EVO.delta_time_ms.offset),
    predictedLapTimeMs: graphicsBuf.readInt32LE(GRAPHICS_EVO.predicted_lap_time_ms.offset),
    deltaCurrent: readCString(graphicsBuf, timBase + TIMING_STATE.delta_current, 15),
    deltaLast: readCString(graphicsBuf, timBase + TIMING_STATE.delta_last, 15),
    idealLapTime: readCString(graphicsBuf, timBase + TIMING_STATE.ideal_laptime, 15),
    timingIsInvalid: graphicsBuf.readUInt8(timBase + TIMING_STATE.is_invalid) !== 0,

    sessionTimeLeftMs: graphicsBuf.readInt32LE(sessBase + SESSION_STATE.time_left_ms),
    sessionTotalLaps: graphicsBuf.readInt32LE(sessBase + SESSION_STATE.total_lap),
    sessionCurrentLap: graphicsBuf.readInt32LE(sessBase + SESSION_STATE.current_lap),
    lapLengthKm: graphicsBuf.readFloatLE(sessBase + SESSION_STATE.lap_length_km),

    escLevel: graphicsBuf.readInt8(elecBase + ELECTRONICS.esc_level),
    engineMapLevel,
    isDrsOpen: graphicsBuf.readUInt8(elecBase + ELECTRONICS.is_drs_open) !== 0,

    clutchPercent: graphicsBuf.readFloatLE(GRAPHICS_EVO.clutch_percent.offset),
    handbrakePercent: graphicsBuf.readFloatLE(GRAPHICS_EVO.handbrake_percent.offset),
    waterTempC: physicsBuf.readFloatLE(PHYSICS.waterTemp.offset),
    oilTempC: graphicsBuf.readFloatLE(GRAPHICS_EVO.oil_temperature_c.offset),
    oilPressureBar: graphicsBuf.readFloatLE(GRAPHICS_EVO.oil_pressure_bar.offset),
    exhaustTempC: graphicsBuf.readFloatLE(GRAPHICS_EVO.exhaust_temperature_c.offset),
    turboBoost: graphicsBuf.readFloatLE(GRAPHICS_EVO.turbo_boost.offset),
    currentTorque: graphicsBuf.readFloatLE(GRAPHICS_EVO.current_torque.offset),
    currentBhp: graphicsBuf.readInt32LE(GRAPHICS_EVO.current_bhp.offset),
    isWrongWay: graphicsBuf.readUInt8(GRAPHICS_EVO.is_wrong_way.offset) !== 0,

    fuelLiters: graphicsBuf.readFloatLE(GRAPHICS_EVO.fuel_liter_current_quantity.offset),
    fuelPercent: graphicsBuf.readFloatLE(GRAPHICS_EVO.fuel_liter_current_quantity_percent.offset),
    fuelLitersPerLap: graphicsBuf.readFloatLE(GRAPHICS_EVO.fuel_liter_per_lap.offset),
    fuelLitersUsed: graphicsBuf.readFloatLE(GRAPHICS_EVO.fuel_liter_used.offset),
    lapsPossibleWithFuel: graphicsBuf.readFloatLE(GRAPHICS_EVO.laps_possible_with_fuel.offset),
    kmPerFuelLiter: graphicsBuf.readFloatLE(GRAPHICS_EVO.km_per_fuel_liter.offset),
    instantaneousKmPerLiter: graphicsBuf.readFloatLE(GRAPHICS_EVO.instantaneous_km_per_fuel_liter.offset),

    brakeDiscLife: [
      physicsBuf.readFloatLE(PHYSICS.discLifeFL.offset),
      physicsBuf.readFloatLE(PHYSICS.discLifeFR.offset),
      physicsBuf.readFloatLE(PHYSICS.discLifeRL.offset),
      physicsBuf.readFloatLE(PHYSICS.discLifeRR.offset),
    ],
    tyreMiddleTempC: [
      physicsBuf.readFloatLE(PHYSICS.tyreTempMiddleFL.offset),
      physicsBuf.readFloatLE(PHYSICS.tyreTempMiddleFR.offset),
      physicsBuf.readFloatLE(PHYSICS.tyreTempMiddleRL.offset),
      physicsBuf.readFloatLE(PHYSICS.tyreTempMiddleRR.offset),
    ],

    localVelocity: [
      physicsBuf.readFloatLE(PHYSICS.localVelocityX.offset),
      physicsBuf.readFloatLE(PHYSICS.localVelocityY.offset),
      physicsBuf.readFloatLE(PHYSICS.localVelocityZ.offset),
    ],

    gapAheadMs: graphicsBuf.readFloatLE(GRAPHICS_EVO.gap_ahead.offset),
    gapBehindMs: graphicsBuf.readFloatLE(GRAPHICS_EVO.gap_behind.offset),

    sessionKm: currentKm,
    totalDrivingTimeS: graphicsBuf.readUInt32LE(GRAPHICS_EVO.total_driving_time_s.offset),

    timeOfDayHours: graphicsBuf.readInt32LE(GRAPHICS_EVO.time_of_day_hours.offset),
    timeOfDayMinutes: graphicsBuf.readInt32LE(GRAPHICS_EVO.time_of_day_minutes.offset),
    timeOfDaySeconds: graphicsBuf.readInt32LE(GRAPHICS_EVO.time_of_day_seconds.offset),
  };

  // --- Derived ---
  const gear = accGear <= 1 ? 0 : accGear - 1;
  const accel = Math.round(gas * 255);
  const brakeVal = Math.round(brake * 255);
  const steer = Math.round(steerAngle * 127);
  const speed = speedKmh / 3.6;

  const INV = 0x7fffffff;
  const currentLap = iCurrentTime > 0 && iCurrentTime !== INV ? iCurrentTime / 1000 : 0;
  const lastLap = iLastTime > 0 && iLastTime !== INV ? iLastTime / 1000 : 0;
  const bestLap = iBestTime > 0 && iBestTime !== INV ? iBestTime / 1000 : 0;
  // Physics-rate distance (see integrateDistance) — fills the 60Hz current_km
  // gaps so distance-keyed charts advance once per ~100Hz frame, not per tick.
  const distanceTraveled = integrateDistance(cache, physPacketId, speed, currentKm);

  const flagStatus = ACEVO_FLAG_NAMES[flagRaw] ?? "none";

  let pitStatus = "out";
  if (isInPitBox) pitStatus = "in_pit";
  else if (isInPitLane || carLocation === ACEVO_CAR_LOCATION.ACEVO_PITLANE) pitStatus = "pit_lane";
  else if (carLocation === ACEVO_CAR_LOCATION.ACEVO_UNASSIGNED) {
    // Pre-session / pre-spawn frames have car_location=UNASSIGNED and all
    // pit flags zero. Driver hasn't moved yet — safest assumption is "in pit
    // garage", so downstream lap detection correctly classifies the first
    // driven lap as an outlap.
    pitStatus = "in_pit";
  }

  const isRaceOn = status === ACEVO_STATUS.AC_LIVE ? 1 : 0;

  const acc: AccExtendedData = {
    tireCompound: tyreCompound || "dry_compound",
    tireCoreTemp: [coreFL, coreFR, coreRL, coreRR],
    tireInnerTemp: [innerFL, innerFR, innerRL, innerRR],
    tireMiddleTemp: [middleFL, middleFR, middleRL, middleRR],
    tireOuterTemp: [outerFL, outerFR, outerRL, outerRR],
    tireCamber: [camberFL, camberFR, camberRL, camberRR],
    wheelLoad: [loadFL, loadFR, loadRL, loadRR],
    // rideHeight not exposed by AC Evo v0.6 physics page — left undefined.
    cgHeight,
    tireRadius: [0, 0, 0, 0], // not in v0.6 static
    tireContactHeading: contactHeading,
    brakePadCompound: 0,
    brakePadWear: [padFL, padFR, padRL, padRR],
    tc: tcLevel,
    tcCut: tcCutLevel,
    abs: absLevel,
    engineMap: engineMapLevel,
    brakeBias,
    tcIntervention: tcActive,
    absIntervention: absActive,
    tcRaw: tcFloat,
    absRaw: absFloat,
    slipVibrations: slipVib,
    absVibrations: absVib,
    rainIntensity: 0,
    trackGripStatus: "unknown",
    windSpeed: 0,
    windDirection: 0,
    airTempC:
      physicsBuf.length >= PHYSICS.airTemp.offset + 4
        ? physicsBuf.readFloatLE(PHYSICS.airTemp.offset)
        : null,
    roadTempC:
      physicsBuf.length >= PHYSICS.roadTemp.offset + 4
        ? physicsBuf.readFloatLE(PHYSICS.roadTemp.offset)
        : null,
    flagStatus,
    drsAvailable: false,
    drsEnabled: false,
    pitStatus,
    fuelPerLap,
    currentSectorIndex: -1,
    lastSectorTime: 0,
    carDamage: {
      front: damFront,
      rear: damRear,
      left: damLeft,
      right: damRight,
      centre: damCentre,
    },
    isValidLap: isValidLap ? true : null,
    acEvo: acEvoExt,
  };

  // Expose AC Evo-specific extras on the acc object for downstream use
  (acc as any).normalizedCarPosition = normalizedCarPos;
  (acc as any).trackLengthM = trackLengthM;

  const packet: TelemetryPacket = {
    gameId: "ac-evo" as GameId,
    acc,
    IsRaceOn: isRaceOn,
    TimestampMS: Date.now(),

    EngineMaxRpm: currentMaxRpm || 0,
    EngineIdleRpm: 0,
    CurrentEngineRpm: rpms,

    AccelerationX: gX * 9.81,
    AccelerationY: gY * 9.81,
    AccelerationZ: gZ * 9.81,
    VelocityX: velX,
    VelocityY: velY,
    VelocityZ: velZ,
    AngularVelocityX: angVelX,
    AngularVelocityY: angVelY,
    AngularVelocityZ: angVelZ,

    Yaw: heading,
    Pitch: pitch,
    Roll: roll,

    // v0.6 signed travel (0 = rest, + = compression, - = extension).
    // Encode as centered 0–1 so the bar fills correctly: 0.5 = rest,
    // >0.5 = compressed, <0.5 = extended. ±50 mm assumed full range.
    // SuspensionTravelMFL carries the raw metres for the mm display label.
    NormSuspensionTravelFL: Math.max(0, Math.min(1, 0.5 + suspFL / 0.1)),
    NormSuspensionTravelFR: Math.max(0, Math.min(1, 0.5 + suspFR / 0.1)),
    NormSuspensionTravelRL: Math.max(0, Math.min(1, 0.5 + suspRL / 0.1)),
    NormSuspensionTravelRR: Math.max(0, Math.min(1, 0.5 + suspRR / 0.1)),

    TireSlipRatioFL: slipRatioFL,
    TireSlipRatioFR: slipRatioFR,
    TireSlipRatioRL: slipRatioRL,
    TireSlipRatioRR: slipRatioRR,

    WheelRotationSpeedFL: rotFL,
    WheelRotationSpeedFR: rotFR,
    WheelRotationSpeedRL: rotRL,
    WheelRotationSpeedRR: rotRR,

    WheelOnRumbleStripFL: 0,
    WheelOnRumbleStripFR: 0,
    WheelOnRumbleStripRL: 0,
    WheelOnRumbleStripRR: 0,
    WheelInPuddleDepthFL: 0,
    WheelInPuddleDepthFR: 0,
    WheelInPuddleDepthRL: 0,
    WheelInPuddleDepthRR: 0,
    SurfaceRumbleFL_2: 0,
    SurfaceRumbleFR_2: 0,
    SurfaceRumbleRL_2: 0,
    SurfaceRumbleRR_2: 0,
    TireSlipCombinedFL_2: 0,

    TireTempFL: tempFL,
    TireTempFR: tempFR,
    TireTempRL: tempRL,
    TireTempRR: tempRR,

    Boost: 0,
    Fuel: fuel,
    DistanceTraveled: distanceTraveled,
    BestLap: bestLap,
    LastLap: lastLap,
    CurrentLap: currentLap,
    CurrentRaceTime: currentLap,

    LapNumber: completedLaps + 1,
    RacePosition: position,

    Accel: accel,
    Brake: brakeVal,
    Clutch: 0,
    HandBrake: 0,
    Gear: gear,
    Steer: steer,
    NormDrivingLine: 0,
    NormAIBrakeDiff: 0,

    TireWearFL: wearFL,
    TireWearFR: wearFR,
    TireWearRL: wearRL,
    TireWearRR: wearRR,

    SurfaceRumbleFL: 0,
    SurfaceRumbleFR: 0,
    SurfaceRumbleRL: 0,
    SurfaceRumbleRR: 0,
    TireSlipAngleFL: slipAngleFL,
    TireSlipAngleFR: slipAngleFR,
    TireSlipAngleRL: slipAngleRL,
    TireSlipAngleRR: slipAngleRR,
    TireCombinedSlipFL: combinedSlipFL,
    TireCombinedSlipFR: combinedSlipFR,
    TireCombinedSlipRL: combinedSlipRL,
    TireCombinedSlipRR: combinedSlipRR,

    SuspensionTravelMFL: suspFL,
    SuspensionTravelMFR: suspFR,
    SuspensionTravelMRL: suspRL,
    SuspensionTravelMRR: suspRR,

    TirePressureFrontLeft: pressFL,
    TirePressureFrontRight: pressFR,
    TirePressureRearLeft: pressRL,
    TirePressureRearRight: pressRR,

    BrakeTempFrontLeft: brTempFL,
    BrakeTempFrontRight: brTempFR,
    BrakeTempRearLeft: brTempRL,
    BrakeTempRearRight: brTempRR,

    CarOrdinal: cache.carOrdinal,
    // Surface the raw model string for unknown cars so the session layer can
    // register them in discovered_cars (task #1) instead of "Unknown Car".
    ...(cache.carOrdinal < 0 && cache.lastCarModel
      ? { carModelName: cache.lastCarModel }
      : {}),
    CarClass: 0,
    CarPerformanceIndex: 0,
    DrivetrainType: 1,
    NumCylinders: 0,

    PositionX: carX,
    PositionY: carY,
    PositionZ: carZ,
    Speed: speed,
    Power: 0,
    Torque: 0,
    TrackOrdinal: cache.trackOrdinal,

    WeatherType: 0,
    TrackTemp: startingGround,
    AirTemp: startingAmbient,
    RainPercent: 0,
  };

  return packet;
}

/**
 * Correlate physics velocity direction with per-slot coordinate deltas to
 * identify which car slot is the player's. v0.6 doesn't expose a per-slot
 * car ID array, so we have to infer.
 */
function calibratePlayerSlot(
  physicsBuf: Buffer,
  graphicsBuf: Buffer,
  cache: AcEvoParserCache,
  activeCars: number,
): void {
  const speedKmh = physicsBuf.readFloatLE(PHYSICS.speedKmh.offset);
  if (speedKmh < SPEED_THRESHOLD_KMH) return;

  const velX = physicsBuf.readFloatLE(PHYSICS.velocityX.offset);
  const velZ = physicsBuf.readFloatLE(PHYSICS.velocityZ.offset);
  const velMag = Math.sqrt(velX * velX + velZ * velZ);
  if (velMag < 0.1) return;

  const coordBase = GRAPHICS_EVO.car_coordinates_base.offset;
  const slotCount = Math.min(activeCars || 1, 60);

  for (let i = 0; i < slotCount; i++) {
    const x = graphicsBuf.readFloatLE(coordBase + i * 12);
    const z = graphicsBuf.readFloatLE(coordBase + i * 12 + 8);
    const prevX = cache._prevCoords[i * 3];
    const prevZ = cache._prevCoords[i * 3 + 2];

    const dx = x - prevX;
    const dz = z - prevZ;
    const dMag = Math.sqrt(dx * dx + dz * dz);

    if (dMag > 0.01) {
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
