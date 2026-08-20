import type { GameId } from "@shared/games/ids";
import { isSampleValid } from "./gearing-validation";

/**
 * Structural telemetry shape the gearing library reads. A live `LiveTelemetryView`
 * is adapted into this by the ingestion host (`useGearingIngest` / `GearingDashboard`),
 * and a `DisplayPacket` satisfies it structurally so the replay/test path
 * (`computeGearingState`, `GearingTestViewer`) keeps working unchanged.
 */
export interface GearingSample {
  gameId: GameId;
  CarOrdinal: number;
  TrackOrdinal: number;
  sessionUID?: string;
  Accel: number;
  Brake: number;
  Gear: number;
  IsRaceOn: number;
  CurrentEngineRpm: number;
  EngineMaxRpm: number;
  EngineIdleRpm: number;
  DisplaySpeed: number;
  AccelerationZ: number;
  DisplayPower: number;
  DisplayTorque: number;
  LapNumber: number;
  DistanceTraveled: number;
}

export interface GearBucket {
  rpmMin: number;
  hpSum: number;
  hpCount: number;
  nmSum: number;
  nmCount: number;
}

const BUCKET_SIZE = 100;
const MAX_ACCEL_HISTORY = 300;

/** One point of the per-lap speed trace: metres from the lap's first sample, speed in the user's unit. */
export interface TrackSpeedSample {
  distance: number;
  speed: number;
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
let lastValidPacket: GearingSample | null = null;
let sessionKey: string | null = null;
let gearRanges: Record<number, { minRpm: number | null; maxRpm: number | null; minSpeed: number | null; maxSpeed: number | null }> = {};
/** When false, ingestGearingTelemetry ignores incoming packets (dyno recording paused). */
let recording = false;
/** Master switch for the automatic start/stop triggers (launch hold, pull-back, top speed). */
let autoRecording = true;
/** Highest DisplaySpeed seen this session (user unit). Tracked continuously by
 *  the ingestion host regardless of the dyno recording pause. */
let maxSpeed = 0;
/** Session key of the last max-speed sample — resets the max on session change. */
let maxSpeedKey: string | null = null;
/** Consecutive full-throttle samples (pull detector). */
let wotStreak = 0;
/** Highest RPM seen during the current WOT stretch. */
let pullMaxRpm = 0;
let brakeHoldStreak = 0;

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
  lastValidPacket = null;
  sessionKey = null;
  gearRanges = {};
  maxSpeed = 0;
  maxSpeedKey = null;
  wotStreak = 0;
  pullMaxRpm = 0;
  brakeHoldStreak = 0;
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
export function setGearingRecording(on: boolean) {
  const wasRecording = recording;
  recording = on;
  // Beep on every transition (manual or auto) so the driver hears the
  // power-band pull start and finish without looking at the screen.
  if (wasRecording !== on) playRecordingBeep();
}

/** Enable/disable the automatic start/stop triggers. Persists across resets. */
export function setAutoRecording(on: boolean) {
  autoRecording = on;
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

/** Throttle (0-255) that counts as a full-throttle pull. */
const WOT_THROTTLE = 240;
/** Sustained WOT samples (~1.5 s at 10 Hz) before a lift counts as a pull. */
const WOT_MIN_SAMPLES = 15;
/** Pull must reach this fraction of the idle→max-RPM span to be worth keeping. */
const PULL_MIN_RPM_RATIO = 0.6;

/**
 * End-of-pull detector: true exactly once per pull when the driver lifts
 * after a sustained full-throttle stretch that climbed well above idle. Lets
 * the recording stop at the lift even when the car never reaches redline.
 */
export function isPullBack(packet: GearingSample): boolean {
  if (packet.Accel >= WOT_THROTTLE) {
    wotStreak++;
    if (packet.CurrentEngineRpm > pullMaxRpm) pullMaxRpm = packet.CurrentEngineRpm;
    return false;
  }
  const span = Math.max(1, packet.EngineMaxRpm - packet.EngineIdleRpm);
  const completed = wotStreak >= WOT_MIN_SAMPLES && pullMaxRpm >= packet.EngineIdleRpm + span * PULL_MIN_RPM_RATIO;
  wotStreak = 0;
  pullMaxRpm = 0;
  return completed;
}

/** Speed (user unit) at or below which the car counts as stopped. */
const STOPPED_SPEED = 0.5;
/** Brake input (0-255) that counts as holding the brake. */
const BRAKE_HOLD = 200;
/** ~2 s of stopped-with-brake samples at ~10 Hz ingestion. */
const LAUNCH_HOLD_SAMPLES = 20;

/**
 * Launch-hold detector: true exactly once when the car sits stopped with the
 * brake held for ~2 s — the auto-start trigger.
 */
export function isLaunchHold(packet: GearingSample): boolean {
  if (packet.DisplaySpeed <= STOPPED_SPEED && packet.Brake >= BRAKE_HOLD) {
    brakeHoldStreak++;
    if (brakeHoldStreak >= LAUNCH_HOLD_SAMPLES) {
      brakeHoldStreak = 0; // one-shot until the next hold
      return true;
    }
    return false;
  }
  brakeHoldStreak = 0;
  return false;
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
  if (isSampleValid(packet) && packet.DisplaySpeed > maxSpeed) maxSpeed = packet.DisplaySpeed;
}

export function ingestGearingTelemetry(packet: GearingSample) {
  // Recording paused (manual toggle or top-speed auto-stop) — ignore packets
  // entirely so a session change while paused cannot wipe frozen data.
  if (!recording) return;

  const key = sessionKeyFor(packet);
  if (key !== sessionKey) {
    resetGearingTelemetry();
    sessionKey = key;
  }

  // Always append AccelerationZ (used for the drop chart regardless of validity)
  accelZHistory = [...accelZHistory, packet.AccelerationZ];
  if (accelZHistory.length > MAX_ACCEL_HISTORY) {
    accelZHistory = accelZHistory.slice(1);
  }

  if (!isSampleValid(packet)) return;

  const gear = packet.Gear;
  const rpm = packet.CurrentEngineRpm;
  const speed = packet.DisplaySpeed;
  if (speed > maxSpeed) maxSpeed = speed;
  const bucketIdx = Math.floor(rpm / BUCKET_SIZE);
  const hp = packet.DisplayPower;
  const nm = packet.DisplayTorque;

  // Track upshift-only min/max RPM and speed
  if (lastValidPacket && gear > lastValidPacket.Gear) {
    const prevGear = lastValidPacket.Gear;
    const prevRpm = lastValidPacket.CurrentEngineRpm;
    const prevSpeed = lastValidPacket.DisplaySpeed;

    // Update previous gear's max (RPM/speed when leaving it)
    if (!gearRanges[prevGear]) {
      gearRanges[prevGear] = { minRpm: null, maxRpm: prevRpm, minSpeed: null, maxSpeed: prevSpeed };
    } else {
      gearRanges[prevGear] = { ...gearRanges[prevGear], maxRpm: prevRpm, maxSpeed: prevSpeed };
    }

    // Update current gear's min (RPM/speed when entering it)
    if (!gearRanges[gear]) {
      gearRanges[gear] = { minRpm: rpm, maxRpm: null, minSpeed: speed, maxSpeed: null };
    } else {
      gearRanges[gear] = { ...gearRanges[gear], minRpm: rpm, minSpeed: speed };
    }
  }

  // Immutable update so React dependency tracking detects changes
  buckets = { ...buckets };
  if (!buckets[gear]) buckets[gear] = {};
  buckets[gear] = { ...buckets[gear] };
  if (!buckets[gear][bucketIdx]) {
    buckets[gear][bucketIdx] = {
      rpmMin: bucketIdx * BUCKET_SIZE,
      hpSum: 0,
      hpCount: 0,
      nmSum: 0,
      nmCount: 0,
    };
  }

  buckets[gear][bucketIdx] = { ...buckets[gear][bucketIdx] };
  const bucket = buckets[gear][bucketIdx];
  if (hp > 0) {
    bucket.hpSum += hp;
    bucket.hpCount += 1;
  }
  if (nm > 0) {
    bucket.nmSum += nm;
    bucket.nmCount += 1;
  }

  lastValidPacket = packet;
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
  let samples = [...trackLaps.current!.samples, { distance, speed: packet.DisplaySpeed, gear: packet.Gear }];
  if (samples.length > MAX_TRACK_SAMPLES) {
    samples = samples.slice(samples.length - MAX_TRACK_SAMPLES);
  }
  trackLaps = { ...trackLaps, current: { lapNumber: trackLaps.current!.lapNumber, samples } };
}

export function getGearingTelemetryState() {
  return { buckets, accelZHistory, lastValidPacket, sessionKey, gearRanges, recording, autoRecording, maxSpeed, trackLaps };
}
