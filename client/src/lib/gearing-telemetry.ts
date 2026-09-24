import type { GameId } from "@shared/games/ids";
import { type EffectiveGears, updateEffectiveGearing } from "./gear-ranges";
import { isSampleValid } from "./gearing-validation";

/**
 * Canonical telemetry sample the gearing library consumes. A live
 * `LiveTelemetryView` is adapted into this by `viewToGearingSample`
 * (`useGearingIngest`); raw `DisplayPacket`s are NOT a valid input. Units
 * are canonical (rpm, watts, Nm, m/s) — presentation converts to the user's
 * unit.
 */
export interface GearingSample {
  gameId: GameId;
  CarOrdinal: number;
  TrackOrdinal: number;
  sessionUID?: string;
  Accel: number;
  Brake: number;
  Gear: number;
  raceActive: boolean;
  rpm: number;
  EngineMaxRpm: number;
  EngineIdleRpm: number;
  speedMps: number;
  AccelerationZ: number;
  powerW: number;
  torqueNm: number;
  LapNumber: number;
  DistanceTraveled: number;
}

export interface GearBucket {
  rpmMin: number;
  powerWSum: number;
  powerWCount: number;
  nmSum: number;
  nmCount: number;
}

export type PowerBandRunPhase = "idle" | "armed" | "pulling";

export interface PowerBandRun {
  id: number;
  buckets: Record<number, Record<number, GearBucket>>;
}

const BUCKET_SIZE = 100;
const MAX_ACCEL_HISTORY = 300;

/** One point of the per-lap speed trace: metres from the lap's first sample, speed in m/s. */
export interface TrackSpeedSample {
  distance: number;
  speedMps: number;
  /** Gear the car was in (raw telemetry gear, e.g. 1-8). */
  gear: number;
}

/** A completed or in-progress lap trace. */
export interface TrackSpeedLap {
  lapNumber: number;
  samples: TrackSpeedSample[];
}

/** Longest trace kept per lap (~10 Hz ingestion → ~10 minutes of lap). */
export const MAX_TRACK_SAMPLES = 6000;
let buckets: Record<number, Record<number, GearBucket>> = {};
let accelZHistory: number[] = [];
let sessionKey: string | null = null;
/** Effective wheel ratio learned continuously from RPM and road speed. */
let effectiveGears: EffectiveGears = {};
let effectiveGearSessionKey: string | null = null;
/** Manual-start pull lifecycle. Pulls arm first, record only at full throttle, then auto-stop on lift or brake. */
let powerBandRunPhase: PowerBandRunPhase = "idle";
let powerBandRuns: PowerBandRun[] = [];
let nextPowerBandRunId = 1;
/** Highest speed seen this session (m/s). Tracked continuously by
 *  the ingestion host regardless of the dyno recording pause. */
let maxSpeed = 0;
/** Session key of the last max-speed sample — resets the max on session change. */
let maxSpeedKey: string | null = null;
const MAX_POWER_BAND_RUNS = 5;

/** Current and most recently completed lap traces fed by the ingestion host
 *  (always-on, dyno recording ignored). The object identity only changes when
 *  a sample is appended or a lap boundary is crossed, so React can skip
 *  re-renders by reference comparison. */
let trackLaps: { current: TrackSpeedLap | null; previous: TrackSpeedLap | null } = { current: null, previous: null };
/** Session key of the current traces — resets both laps on car/track/session change. */
let trackSessionKey: string | null = null;
/** DistanceTraveled at the start of the current lap (x-axis baseline). */
let trackLapStartDistance = 0;
/** Identity of a car/track/session — the boundary that resets gearing state. */
export const sessionKeyFor = (packet: GearingSample) => `${packet.CarOrdinal}:${packet.TrackOrdinal}:${packet.sessionUID ?? ""}`;

export function resetGearingTelemetry() {
  buckets = {};
  accelZHistory = [];
  sessionKey = null;
  effectiveGears = {};
  effectiveGearSessionKey = null;
  powerBandRunPhase = "idle";
  powerBandRuns = [];
  nextPowerBandRunId = 1;
  maxSpeed = 0;
  maxSpeedKey = null;
  trackSessionKey = null;
  trackLapStartDistance = 0;
  trackLaps = { current: null, previous: null };
}

/** Clear only the per-lap track traces — dyno buckets and recording state stay untouched. */
export function resetTrackLaps() {
  trackLaps = { current: null, previous: null };
  trackSessionKey = null;
  trackLapStartDistance = 0;
}
/** Arm a fresh pull without clearing completed runs or unrelated lap/speed data. */
export function startPowerBandRun() {
  buckets = {};
  accelZHistory = [];
  powerBandRunPhase = "armed";
  playRecordingBeep();
}

/** Finish the active pull and retain its immutable buckets in newest-first session history. */
export function completePowerBandRun() {
  if (powerBandRunPhase === "idle") return;
  if (Object.keys(buckets).length > 0) {
    powerBandRuns = [{ id: nextPowerBandRunId++, buckets }, ...powerBandRuns].slice(0, MAX_POWER_BAND_RUNS);
  }
  powerBandRunPhase = "idle";
  playRecordingBeep();
}

let beepAudio: HTMLAudioElement | null = null;

/** Plays the bundled beep. No-op where audio is unavailable. */
export function playRecordingBeep() {
  if (typeof Audio === "undefined") return;
  try {
    beepAudio ??= new Audio("/sounds/beep-2.mp3");
    beepAudio.currentTime = 0;
    void beepAudio.play().catch(() => {
      // Autoplay blocked — the state change still happens.
    });
  } catch {
    // Audio unavailable — the state change still happens.
  }
}

/** Throttle (0-255) that marks the start and continuation of a valid full-throttle pull. */
const WOT_THROTTLE = 240;
/** Brake input (0-255) that ends an active pull. */
const PULL_END_BRAKE = 32;

/**
 * Advance the manual-start pull lifecycle for one accepted source sample.
 * Armed samples are ignored until full throttle. Once pulling, lift or brake
 * completes the run before that dirty end sample reaches the accumulators.
 */
export function advancePowerBandRun(packet: GearingSample): "ignore" | "record" | "complete" {
  if (powerBandRunPhase === "idle") return "ignore";
  if (powerBandRunPhase === "armed") {
    if (packet.Accel < WOT_THROTTLE || packet.Brake >= PULL_END_BRAKE) return "ignore";
    powerBandRunPhase = "pulling";
    return "record";
  }
  if (packet.Accel < WOT_THROTTLE || packet.Brake >= PULL_END_BRAKE) {
    completePowerBandRun();
    return "complete";
  }
  return "record";
}

/**
 * Always-on session max-speed tracker. Called by the ingestion host on every
 * throttled packet — independent of the dyno recording pause — so the hero
 * readout keeps climbing across laps and dashboard modes. Resets when the
 * car/track/session changes.
 */
export function trackGearingMaxSpeed(packet: GearingSample) {
  const key = sessionKeyFor(packet);
  if (key !== maxSpeedKey) {
    maxSpeedKey = key;
    maxSpeed = 0;
  }
  if (isSampleValid(packet) && packet.speedMps > maxSpeed) maxSpeed = packet.speedMps;
}

/** Learn effective wheel ratios continuously, independent of dyno recording. */
export function trackEffectiveGearing(packet: GearingSample) {
  const key = sessionKeyFor(packet);
  if (key !== effectiveGearSessionKey) {
    effectiveGearSessionKey = key;
    effectiveGears = {};
  }
  effectiveGears = updateEffectiveGearing(effectiveGears, packet);
}

export function ingestGearingTelemetry(packet: GearingSample) {
  if (powerBandRunPhase !== "pulling") return;

  const key = sessionKeyFor(packet);
  if (key !== sessionKey) {
    buckets = {};
    accelZHistory = [];
    powerBandRuns = [];
    nextPowerBandRunId = 1;
    sessionKey = key;
  }

  // Always append AccelerationZ (used for the drop chart regardless of validity)
  accelZHistory = [...accelZHistory, packet.AccelerationZ];
  if (accelZHistory.length > MAX_ACCEL_HISTORY) {
    accelZHistory = accelZHistory.slice(1);
  }

  if (!isSampleValid(packet)) return;

  const gear = packet.Gear;
  const rpm = packet.rpm;
  const speed = packet.speedMps;
  if (speed > maxSpeed) maxSpeed = speed;
  const bucketIdx = Math.floor(rpm / BUCKET_SIZE);
  const powerW = packet.powerW;
  const nm = packet.torqueNm;

  // Immutable update so React dependency tracking detects changes
  buckets = { ...buckets };
  if (!buckets[gear]) buckets[gear] = {};
  buckets[gear] = { ...buckets[gear] };
  if (!buckets[gear][bucketIdx]) {
    buckets[gear][bucketIdx] = {
      rpmMin: bucketIdx * BUCKET_SIZE,
      powerWSum: 0,
      powerWCount: 0,
      nmSum: 0,
      nmCount: 0,
    };
  }

  buckets[gear][bucketIdx] = { ...buckets[gear][bucketIdx] };
  const bucket = buckets[gear][bucketIdx];
  if (powerW > 0) {
    bucket.powerWSum += powerW;
    bucket.powerWCount += 1;
  }
  if (nm > 0) {
    bucket.nmSum += nm;
    bucket.nmCount += 1;
  }
}

/**
 * Always-on per-lap speed-trace accumulator. Called by the ingestion host on
 * every throttled packet — independent of the dyno recording pause — so the
 * Track Speed chart keeps drawing across laps and dashboard modes. The
 * finished lap is retained as `previous` so the chart can toggle back to it;
 * only a car/track/session change clears both traces.
 */
export function trackTrackSpeedSample(packet: GearingSample) {
  // Skip invalid samples (menus, neutral, reverse) so the trace only covers real driving.
  if (!isSampleValid(packet)) return;

  const key = sessionKeyFor(packet);
  const current = trackLaps.current;
  if (key !== trackSessionKey || !current) {
    // New session (or first sample): start fresh, discard prior laps.
    trackSessionKey = key;
    trackLaps = { current: { lapNumber: packet.LapNumber, samples: [] }, previous: null };
    trackLapStartDistance = packet.DistanceTraveled;
  } else if (packet.LapNumber !== current.lapNumber) {
    // Lap boundary: retain the finished lap as previous, start a fresh trace.
    // An empty current lap (no valid samples since its start) is replaced,
    // not demoted.
    trackLaps = {
      previous: current.samples.length > 0 ? current : trackLaps.previous,
      current: { lapNumber: packet.LapNumber, samples: [] },
    };
    trackLapStartDistance = packet.DistanceTraveled;
  }

  // Clamp at the baseline: a game that resets DistanceTraveled per lap must
  // not make the x-axis go negative.
  const distance = Math.max(0, packet.DistanceTraveled - trackLapStartDistance);
  const currentLap = trackLaps.current!;
  const samples = currentLap.samples;
  samples.push({ distance, speedMps: packet.speedMps, gear: packet.Gear });
  if (samples.length > MAX_TRACK_SAMPLES) {
    samples.splice(0, samples.length - MAX_TRACK_SAMPLES);
  }
  // Publish new wrapper identities for React while retaining one bounded
  // backing array instead of copying the full trace for every sample.
  trackLaps = { ...trackLaps, current: { lapNumber: currentLap.lapNumber, samples } };
}

export function getGearingTelemetryState() {
  return { buckets, accelZHistory, sessionKey, effectiveGears, powerBandRunPhase, powerBandRuns, maxSpeed, trackLaps };
}
