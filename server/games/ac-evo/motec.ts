/**
 * MoTeC `.ld` → AC Evo session `.bin` transcoder.
 *
 * ## Why go through `.bin` at all
 *
 * Every consumer downstream of ingest — lap detection, sector timing, corner
 * detection, lap metrics, the analyse charts, the AI prompts — reads a
 * `TelemetryPacket` produced by a game adapter's `tryParse`. Rather than add a
 * second, parallel "imported lap" path that every one of those would have to
 * learn about, this module writes the MoTeC samples into the AC Evo
 * shared-memory page layout and emits frames in the canonical session-capture
 * framing. `importSessionBin` then runs them through the *real* pipeline, and
 * the resulting laps are indistinguishable from recorded ones — including
 * re-materialisation from the stored capture, because the pipeline's own
 * recorder persists the frames it was fed.
 *
 * So this file's whole job is: MoTeC channel arrays → AC Evo pages.
 *
 * ## Position, which MoTeC does not log directly
 *
 * A MoTeC AC Evo export has no world-position channels — no `CAR_COORD_*`, no
 * GPS — but the track map does not need them: it renders the per-packet
 * `PositionX/PositionZ` path, and that path can be dead-reckoned from speed and
 * yaw rate. This is exactly how MoTeC i2 draws its own track maps.
 *
 * {@link deadReckonPath} integrates heading from yaw rate (`ROTY`, or lateral G
 * over speed when `ROTY` is absent) and advances position along it. The result
 * is genuinely lap-specific — a lap carrying more speed through a corner traces
 * a visibly different arc — so line-spread and lap-comparison stay meaningful
 * rather than showing every lap on one identical synthetic line.
 *
 * The frame is reset to the origin at each lap start, so laps overlay each other
 * instead of marching away as integration drift accumulates across a stint. The
 * geometry is therefore lap-relative and approximate: good for comparing shapes,
 * not a survey of the circuit. Sessions carry a `motec` source flag so the UI can
 * say so. See {@link MOTEC_IMPORT_LIMITATIONS}.
 *
 * ## Steering
 *
 * MoTeC logs `STEERANGLE` in degrees of wheel rotation and does not export the
 * car's steering lock, while AC Evo's physics page carries a normalised -1..1.
 * We divide by a fixed {@link STEER_LOCK_DEG} rather than by the log's own peak:
 * a fixed divisor is wrong by a constant per car, but it is the *same* constant
 * for every import, so two imported laps remain comparable. Normalising per-log
 * would silently rescale each import by how much lock that particular stint
 * happened to use.
 */

import {
  ACEVO_CAR_LOCATION,
  ACEVO_SESSION_TYPE,
  ACEVO_STATUS,
  GRAPHICS_EVO,
  PHYSICS,
  SESSION_STATE,
  STATIC_EVO,
} from "./structs";
import { ACEVO_PACKED_MAGIC, packTriplet } from "../kunos/pack-triplet";
import { encodeFrameLength, encodeMetaFrame } from "../../session-capture/framing";
import { getAcEvoCarByModel, getAcEvoCarName } from "../../../shared/racing/cars/ac-evo"
import { getAcEvoTrackByName,
getAcEvoTrackBySetupFolder,
getAcEvoTracks, } from "../../../shared/racing/tracks/catalogs/ac-evo"
import { findChannel, type LdChannel, type LdLog } from "../../motec/ld";
import type {
  MotecCarTrack,
  MotecCarTrackOverride,
  SynthesizeResult,
} from "../../motec/types";
import {
  SOURCE_CHANNEL_PROFILE_VERSION,
  type SourceChannelProfile,
  type SourceChannelProfileEntry,
} from "../../../shared/racing/quality/contracts";

/**
 * Frame rate of the synthesized capture. MoTeC's AC Evo export logs the driver
 * inputs (`STEERANGLE`, `SPEED`, `THROTTLE`, `BRAKE`, `RPMS`) at 60 Hz, which is
 * the fastest rate that carries anything the pipeline reads. Emitting faster
 * would duplicate samples and inflate the capture without adding information;
 * emitting slower would throw away input detail. The 200 Hz suspension bucket is
 * genuinely decimated by this choice — noted in {@link MOTEC_IMPORT_LIMITATIONS}.
 */
export const SYNTH_HZ = 60;

/**
 * Assumed full-lock steering, in degrees, used to normalise `STEERANGLE`.
 * ~±240° covers GT3 and most race cars. Road cars with a larger lock saturate at
 * ±1, which is visible in the trace rather than silently rescaled.
 */
export const STEER_LOCK_DEG = 240;

/** A lap shorter than this is not a lap — the detector's reset rule needs >30 s. */
const MIN_LAP_SECONDS = 30;

/** Honest, user-facing list of what an import cannot carry. Surfaced by the route. */
export const MOTEC_IMPORT_LIMITATIONS = [
  "The racing line is dead-reckoned from speed and yaw rate, not logged — it is lap-relative and drifts, so treat it as shape, not survey geometry.",
  "Steering is normalised against an assumed 240° lock — MoTeC does not export the car's steering lock.",
  "Suspension and wheel-speed channels are logged by MoTeC at 200 Hz and are resampled down to 60 Hz.",
  "Sector times are recomputed from track geometry, not read from the log.",
] as const;

/** Channel-name candidates, in preference order. MoTeC exporters vary. */
const CHANNELS = {
  speed: ["SPEED", "GROUND_SPEED", "Ground Speed"],
  throttle: ["THROTTLE", "Throttle Pos", "THROTTLE_POS"],
  brake: ["BRAKE", "Brake Pos", "BRAKE_POS"],
  clutch: ["CLUTCH"],
  steer: ["STEERANGLE", "STEER_ANGLE", "Steering Angle"],
  rpm: ["RPMS", "RPM", "Engine RPM", "EN_RPM"],
  gear: ["GEAR"],
  gLat: ["G_LAT", "G Force Lat"],
  gLon: ["G_LON", "G Force Long"],
  yawRate: ["ROTY", "YAW_RATE"],
  fuel: ["FUEL_LEVEL", "FUEL", "EN_FUEL_LEVEL"],
  tc: ["TC"],
  abs: ["ABS"],
  brakeTemp: (c: string) => [`BRAKE_TEMP_${c}`],
  tyrePress: (c: string) => [`TYRE_PRESS_${c}`],
  tyreTemp: (c: string) => [`TYRE_TAIR_${c}`, `TYRE_TEMP_${c}`],
  suspTravel: (c: string) => [`SUS_TRAVEL_${c}`],
  wheelSpeed: (c: string) => [`WHEEL_SPEED_${c}`],
  beacon: ["LAP_BEACON"],
} as const;

/** MoTeC corner suffixes, in AC's FL/FR/RL/RR order. */
const CORNERS = ["LF", "RF", "LR", "RR"] as const;

function pick(log: LdLog, names: readonly string[]): LdChannel | undefined {
  for (const n of names) {
    const found = findChannel(log, n);
    if (found) return found;
  }
  return undefined;
}

/**
 * Resample a channel onto the synthesis timeline by nearest-sample hold.
 *
 * No interpolation: a value the logger never recorded is not a value we should
 * invent between two it did. Holding the last real sample is what a slower
 * consumer of the same log would see.
 */
function resample(channel: LdChannel | undefined, frames: number, dt: number): Float64Array {
  const out = new Float64Array(frames);
  if (!channel || channel.samples.length === 0 || channel.effectiveFreq <= 0) return out;
  const last = channel.samples.length - 1;
  for (let i = 0; i < frames; i++) {
    const idx = Math.round(i * dt * channel.effectiveFreq);
    out[i] = channel.samples[Math.max(0, Math.min(last, idx))] ?? 0;
  }
  return out;
}

/** Peak absolute value, used for unit sniffing. */
function peakAbs(values: Float64Array): number {
  let peak = 0;
  for (const v of values) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Normalise a pedal trace to 0..1. Exporters disagree on whether `THROTTLE` is a
 * fraction or a percentage, and the channel `unit` is frequently blank, so sniff
 * it from the data: a pedal that ever exceeds 1.5 was logged as a percentage.
 */
function normalizePedal(values: Float64Array): Float64Array {
  const scale = peakAbs(values) > 1.5 ? 0.01 : 1;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = Math.max(0, Math.min(1, values[i]! * scale));
  }
  return out;
}

/** Convert a speed trace to km/h, honouring the channel's declared unit. */
function speedToKmh(values: Float64Array, channel: LdChannel | undefined): Float64Array {
  const unit = (channel?.unit ?? "").toLowerCase();
  const factor = unit.includes("m/s") || unit === "ms" ? 3.6 : unit.includes("mph") ? 1.609344 : 1;
  if (factor === 1) return values;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i]! * factor;
  return out;
}

export interface DeadReckonedPath {
  /** World X, metres, relative to the start of each lap. */
  x: Float64Array;
  /** World Z, metres, relative to the start of each lap. */
  z: Float64Array;
  /** World-frame velocity components, metres/second. */
  vx: Float64Array;
  vz: Float64Array;
  /** True when yaw came from lateral G rather than a real `ROTY` channel. */
  yawFromLateralG: boolean;
}

/** Gravity, for converting a lateral-G trace into m/s². */
const G = 9.80665;

/**
 * Below this speed, curvature derived from lateral G (`ω = a_lat / v`) explodes.
 * Heading is held instead — a car this slow contributes almost no arc anyway.
 */
const MIN_SPEED_FOR_CURVATURE_MS = 3;

/**
 * Reconstruct a track path by integrating heading from yaw rate and position
 * along that heading.
 *
 * Heading starts at zero and the origin resets on every lap boundary, so each
 * lap is expressed in its own frame anchored at the start/finish line. That is
 * what makes two laps overlay: absolute orientation is unknowable from this data
 * anyway, and letting drift accumulate across a whole stint would walk later
 * laps off the map.
 *
 * `ROTY` is preferred. When it is missing, yaw rate is recovered from the
 * lateral-G trace as `ω = a_lat·g / v`, which is the standard steady-state
 * relation and is how a track map can be built from a G-trace alone.
 */
export function deadReckonPath(
  speedKmh: Float64Array,
  yawRate: Float64Array,
  gLat: Float64Array,
  lapIndexOf: Int32Array,
  dt: number,
  yawUnit: string,
): DeadReckonedPath {
  const frames = speedKmh.length;
  const x = new Float64Array(frames);
  const z = new Float64Array(frames);
  const vx = new Float64Array(frames);
  const vz = new Float64Array(frames);

  const hasYaw = peakAbs(yawRate) > 0;
  // MoTeC writes yaw rate as either rad/s or deg/s depending on exporter.
  const yawToRad = /deg|°/i.test(yawUnit) ? Math.PI / 180 : 1;

  let heading = 0;
  let px = 0;
  let pz = 0;
  for (let i = 0; i < frames; i++) {
    // Every lap starts at the origin pointing the same way, including the very
    // first. The first frame of a lap must therefore be stored *before* any
    // advance, or laps would each begin one step off in a different direction
    // and no longer overlay exactly.
    const isLapStart = i === 0 || lapIndexOf[i] !== lapIndexOf[i - 1];
    if (isLapStart) {
      heading = 0;
      px = 0;
      pz = 0;
    }

    const v = speedKmh[i]! / 3.6;
    const omega = hasYaw
      ? yawRate[i]! * yawToRad
      : v > MIN_SPEED_FOR_CURVATURE_MS
        ? (gLat[i]! * G) / v
        : 0;

    if (!isLapStart) heading += omega * dt;

    // Heading is measured from +Z toward +X, matching the adapter's
    // "standard-xyz" convention where the map plots X across and Z along.
    const cx = Math.sin(heading) * v;
    const cz = Math.cos(heading) * v;
    if (!isLapStart) {
      px += cx * dt;
      pz += cz * dt;
    }

    vx[i] = cx;
    vz[i] = cz;
    x[i] = px;
    z[i] = pz;
  }

  closeLapLoops(x, z, lapIndexOf);
  return { x, z, vx, vz, yawFromLateralG: !hasYaw };
}

/**
 * Force each completed lap's path to return to its own start.
 *
 * Integrated heading accumulates error, so a reconstructed lap of a closed
 * circuit ends some distance from where it began. Spreading that closure error
 * back over the lap as a linear ramp is the standard correction: it removes the
 * accumulated bias with the least distortion per sample, and it matters
 * practically because `assessLapRecording` rejects a lap whose start and end
 * positions are far apart — uncorrected drift would mark every imported lap
 * invalid.
 *
 * The final lap is left alone: a partial out-lap is not expected to close, and
 * forcing it to would bend a legitimately open path into a fake loop.
 */
function closeLapLoops(x: Float64Array, z: Float64Array, lapIndexOf: Int32Array): void {
  const frames = x.length;
  if (frames === 0) return;
  const lastLap = lapIndexOf[frames - 1]!;

  let start = 0;
  for (let i = 1; i <= frames; i++) {
    const boundary = i === frames || lapIndexOf[i] !== lapIndexOf[start];
    if (!boundary) continue;

    const end = i - 1;
    const span = end - start;
    if (lapIndexOf[start]! !== lastLap && span > 0) {
      const errX = x[end]! - x[start]!;
      const errZ = z[end]! - z[start]!;
      for (let j = start; j <= end; j++) {
        const t = (j - start) / span;
        x[j] = x[j]! - errX * t;
        z[j] = z[j]! - errZ * t;
      }
    }
    start = i;
  }
}

function writeCString(buf: Buffer, offset: number, size: number, value: string): void {
  buf.fill(0, offset, offset + size);
  // latin1 keeps one byte per char, matching the fixed-width char[] in the struct.
  buf.write(value.slice(0, size - 1), offset, "latin1");
}

export type { MotecCarTrack, MotecCarTrackOverride };

/**
 * Resolve which car and track this log belongs to.
 *
 * The header is only a hint. MoTeC writes AC's *folder* ids
 * (`mercedes_amg_gt3_evo`, `spa`), which we can usually translate — but the
 * strings come from whichever exporter wrote the file, a track can be logged
 * under a layout we don't match, and a car may simply not be in cars.csv. So the
 * import asks the user which car and track it is, and those answers take
 * priority over anything parsed out of the header. Guessing wrong here silently
 * files a lap under the wrong track, where its sectors and corner names are
 * quietly meaningless.
 *
 * With no override we fall back to the header, and when *that* fails we pass the
 * raw string through rather than inventing a match — which lets the AC Evo lap
 * detector register an unknown car in `discovered_cars` exactly as it does for
 * an unknown live one.
 */
export function resolveMotecCarTrack(
  log: LdLog,
  override?: MotecCarTrackOverride,
): MotecCarTrack {
  const car =
    override?.carOrdinal !== undefined && override.carOrdinal >= 0
      ? { id: override.carOrdinal, name: getAcEvoCarName(override.carOrdinal) }
      : getAcEvoCarByModel(log.vehicleId);

  const track =
    override?.trackOrdinal !== undefined && override.trackOrdinal >= 0
      ? getAcEvoTracks().get(override.trackOrdinal)
      : (getAcEvoTrackBySetupFolder(log.venue) ?? getAcEvoTrackByName(log.venue));

  return {
    carOrdinal: car?.id ?? -1,
    trackOrdinal: track?.id ?? -1,
    carModel: car?.name ?? log.vehicleId,
    trackName: track?.commonTrackName ?? log.venue,
  };
}

/**
 * Lap boundaries in seconds, as `[start, end]` pairs.
 *
 * Beacons from the `.ldx` sidecar are the split points. A log with no beacons is
 * one unsplit stint, which is the normal shape for a standalone hotlap export.
 * Boundaries closer together than {@link MIN_LAP_SECONDS} are merged, because
 * the AC Evo lap detector only recognises a lap reset after a >30 s lap timer —
 * emitting shorter ones would produce frames it silently never splits.
 */
export function lapWindows(beacons: number[], duration: number): Array<[number, number]> {
  const splits = beacons.filter((t) => t > 0 && t < duration).sort((a, b) => a - b);
  const bounds = [0, ...splits, duration];
  const windows: Array<[number, number]> = [];
  let start = bounds[0]!;
  for (let i = 1; i < bounds.length; i++) {
    const end = bounds[i]!;
    // Merge a too-short slice forward into the next one rather than dropping it,
    // so the stint's elapsed time and distance stay continuous.
    if (end - start < MIN_LAP_SECONDS && i < bounds.length - 1) continue;
    windows.push([start, end]);
    start = end;
  }
  if (windows.length === 0) windows.push([0, duration]);
  return windows;
}

export type { SynthesizeResult };

/**
 * Transcode a parsed MoTeC log (plus its `.ldx` beacons) into a session capture.
 */
export function synthesizeAcEvoCapture(
  log: LdLog,
  beacons: number[],
  override?: MotecCarTrackOverride,
): SynthesizeResult {
  const dt = 1 / SYNTH_HZ;
  const duration = log.duration;
  if (!(duration > 0)) throw new Error("MoTeC log has no usable duration");
  const frames = Math.max(1, Math.floor(duration * SYNTH_HZ));

  const missingChannels: string[] = [];
  const take = (names: readonly string[]): LdChannel | undefined => {
    const found = pick(log, names);
    if (!found) missingChannels.push(names[0]!);
    return found;
  };

  // --- resample every channel we consume onto the synthesis timeline ---
  const speedCh = take(CHANNELS.speed);
  const throttleCh = take(CHANNELS.throttle);
  const brakeCh = take(CHANNELS.brake);
  const clutchCh = pick(log, CHANNELS.clutch);
  const steerCh = take(CHANNELS.steer);
  const rpmCh = take(CHANNELS.rpm);
  const gearCh = take(CHANNELS.gear);
  const gLatCh = take(CHANNELS.gLat);
  const gLonCh = take(CHANNELS.gLon);
  const yawCh = pick(log, CHANNELS.yawRate);
  const fuelCh = pick(log, CHANNELS.fuel);
  const tcCh = pick(log, CHANNELS.tc);
  const absCh = pick(log, CHANNELS.abs);
  const brakeTempCh = CORNERS.map((c) => pick(log, CHANNELS.brakeTemp(c)));
  const tyrePressCh = CORNERS.map((c) => pick(log, CHANNELS.tyrePress(c)));
  const tyreTempCh = CORNERS.map((c) => pick(log, CHANNELS.tyreTemp(c)));
  const suspTravelCh = CORNERS.map((c) => pick(log, CHANNELS.suspTravel(c)));
  const wheelSpeedCh = CORNERS.map((c) => pick(log, CHANNELS.wheelSpeed(c)));

  const speedKmh = speedToKmh(resample(speedCh, frames, dt), speedCh);
  const throttle = normalizePedal(resample(throttleCh, frames, dt));
  const brake = normalizePedal(resample(brakeCh, frames, dt));
  const clutch = normalizePedal(resample(clutchCh, frames, dt));
  const steerDeg = resample(steerCh, frames, dt);
  const rpm = resample(rpmCh, frames, dt);
  const gear = resample(gearCh, frames, dt);
  const gLat = resample(gLatCh, frames, dt);
  const gLon = resample(gLonCh, frames, dt);
  const yawRate = resample(yawCh, frames, dt);
  const fuel = resample(fuelCh, frames, dt);
  const tc = resample(tcCh, frames, dt);
  const abs = resample(absCh, frames, dt);

  const brakeTemp = brakeTempCh.map((channel) => resample(channel, frames, dt));
  const tyrePress = tyrePressCh.map((channel) => resample(channel, frames, dt));
  const tyreTemp = tyreTempCh.map((channel) => resample(channel, frames, dt));
  const suspTravel = suspTravelCh.map((channel) => resample(channel, frames, dt));
  const wheelSpeed = wheelSpeedCh.map((channel) => resample(channel, frames, dt));

  const carTrack = resolveMotecCarTrack(log, override);
  const windows = lapWindows(beacons, duration);

  // --- distance, integrated from speed ---
  // Two different quantities, and conflating them breaks lap detection:
  //
  //   `sessionDistM` feeds graphics `current_km`, which AC Evo defines as
  //   distance *this session* — cumulative, never resetting. The AC Evo lap
  //   detector treats a >100 m backward jump in DistanceTraveled as a session
  //   restart and discards the lap buffer, so a per-lap reset here would clear
  //   the buffer at every beacon and no lap would ever be emitted.
  //
  //   `lapDistM` is distance since the current lap began, and is only used for
  //   the normalised track position `npos`.
  const lapIndexOf = new Int32Array(frames);
  const sessionDistM = new Float64Array(frames);
  const lapDistM = new Float64Array(frames);
  {
    let lap = 0;
    let session = 0;
    let lapStartDist = 0;
    for (let i = 0; i < frames; i++) {
      const t = i * dt;
      while (lap < windows.length - 1 && t >= windows[lap]![1]) {
        lap++;
        lapStartDist = session;
      }
      if (i > 0) session += (speedKmh[i]! / 3.6) * dt;
      lapIndexOf[i] = lap;
      sessionDistM[i] = session;
      lapDistM[i] = session - lapStartDist;
    }
  }

  // Lap length from the longest completed lap's integrated distance. A partial
  // final lap must not shorten it, so only closed windows count.
  let lapLengthM = 0;
  for (let i = 0; i < frames; i++) {
    const isLastFrameOfLap = i + 1 >= frames || lapIndexOf[i + 1] !== lapIndexOf[i];
    if (isLastFrameOfLap && lapIndexOf[i]! < windows.length - 1) {
      lapLengthM = Math.max(lapLengthM, lapDistM[i]!);
    }
  }
  if (lapLengthM === 0) lapLengthM = lapDistM[frames - 1] ?? 0;

  const path = deadReckonPath(speedKmh, yawRate, gLat, lapIndexOf, dt, yawCh?.unit ?? "");
  const usableChannel = (
    channel: LdChannel | undefined,
  ): channel is LdChannel =>
    channel !== undefined &&
    channel.samples.length > 0 &&
    channel.effectiveFreq > 0;
  const rateTreatment = (
    channels: readonly (LdChannel | undefined)[],
  ): SourceChannelProfileEntry["treatment"] => {
    const present = channels.filter(usableChannel);
    if (present.length === 0) return "absent";
    if (
      present.every(
        ({ effectiveFreq }) =>
          Math.abs(effectiveFreq - SYNTH_HZ) <= SYNTH_HZ * 0.01,
      )
    ) {
      return "direct";
    }
    if (present.every(({ effectiveFreq }) => effectiveFreq < SYNTH_HZ)) {
      return "held";
    }
    return "resampled";
  };
  const availabilityMapping = (
    channels: readonly (LdChannel | undefined)[],
    available: SourceChannelProfileEntry["mappingStatus"],
  ): SourceChannelProfileEntry["mappingStatus"] =>
    channels.length > 0 && channels.every(usableChannel)
      ? available
      : "unavailable";
  const sourceEntry = (
    semanticId: string,
    treatment: SourceChannelProfileEntry["treatment"],
    mappingStatus: SourceChannelProfileEntry["mappingStatus"],
    channels: readonly (LdChannel | undefined)[],
    limitations: string[],
  ): SourceChannelProfileEntry => ({
    treatment,
    mappingStatus,
    sourceChannels: channels.filter(usableChannel).map((channel) => ({
      name: channel.name,
      declaredHz: Number.isFinite(channel.declaredFreq)
        ? channel.declaredFreq
        : null,
      effectiveHz: Number.isFinite(channel.effectiveFreq)
        ? channel.effectiveFreq
        : null,
    })),
    limitations,
    evidenceId: `source-channel-profile:${SOURCE_CHANNEL_PROFILE_VERSION}:motec:${semanticId}`,
  });
  const timingEntry = (
    semanticId: string,
    treatment: SourceChannelProfileEntry["treatment"],
    mappingStatus: SourceChannelProfileEntry["mappingStatus"],
    sourceName: string | null,
    limitation: string,
  ): SourceChannelProfileEntry => ({
    treatment,
    mappingStatus,
    sourceChannels:
      sourceName === null
        ? []
        : [{ name: sourceName, declaredHz: null, effectiveHz: null }],
    limitations: [limitation],
    evidenceId: `source-channel-profile:${SOURCE_CHANNEL_PROFILE_VERSION}:motec:${semanticId}`,
  });
  const positionCurvatureChannel = path.yawFromLateralG ? gLatCh : yawCh;
  const positionAvailable =
    usableChannel(speedCh) && usableChannel(positionCurvatureChannel);
  const positionChannels = [speedCh, positionCurvatureChannel];
  const positionLimitation = path.yawFromLateralG
    ? "Position dead-reckoned from speed and lateral acceleration."
    : "Position dead-reckoned from speed and yaw rate.";
  const sourceChannelProfile: SourceChannelProfile = {
    schemaVersion: SOURCE_CHANNEL_PROFILE_VERSION,
    sourceKind: "motec",
    channels: {
      "timing.last-lap":
        beacons.length > 0
          ? timingEntry(
              "timing.last-lap",
              "direct",
              "derived",
              "MoTeC lap beacons",
              "Lap timing derived from MoTeC beacon windows.",
            )
          : timingEntry(
              "timing.last-lap",
              "absent",
              "unavailable",
              null,
              "MoTeC log has no lap beacons.",
            ),
      "timing.current-lap": timingEntry(
        "timing.current-lap",
        "direct",
        "derived",
        "MoTeC log timeline",
        "Current lap time synthesized from MoTeC capture timeline.",
      ),
      "timing.distance-traveled": sourceEntry(
        "timing.distance-traveled",
        usableChannel(speedCh) ? "dead-reckoned" : "absent",
        usableChannel(speedCh) ? "derived" : "unavailable",
        [speedCh],
        [
          usableChannel(speedCh)
            ? "Distance integrated from speed."
            : "MoTeC speed channel unavailable; distance has no evidence.",
        ],
      ),
      "motion.position-x": sourceEntry(
        "motion.position-x",
        positionAvailable ? "dead-reckoned" : "absent",
        positionAvailable ? "derived" : "unavailable",
        positionChannels,
        [
          positionAvailable
            ? positionLimitation
            : "MoTeC position inputs unavailable.",
        ],
      ),
      "motion.position-z": sourceEntry(
        "motion.position-z",
        positionAvailable ? "dead-reckoned" : "absent",
        positionAvailable ? "derived" : "unavailable",
        positionChannels,
        [
          positionAvailable
            ? positionLimitation
            : "MoTeC position inputs unavailable.",
        ],
      ),
      "motion.speed": sourceEntry(
        "motion.speed",
        rateTreatment([speedCh]),
        usableChannel(speedCh) ? "normalized" : "unavailable",
        [speedCh],
        [
          usableChannel(speedCh)
            ? "Speed unit-normalized on the 60 Hz capture timeline."
            : "MoTeC speed channel unavailable.",
        ],
      ),
      "inputs.accel": sourceEntry(
        "inputs.accel",
        rateTreatment([throttleCh]),
        usableChannel(throttleCh) ? "normalized" : "unavailable",
        [throttleCh],
        [
          usableChannel(throttleCh)
            ? "Throttle range-normalized on the 60 Hz capture timeline."
            : "MoTeC throttle channel unavailable.",
        ],
      ),
      "inputs.brake": sourceEntry(
        "inputs.brake",
        rateTreatment([brakeCh]),
        usableChannel(brakeCh) ? "normalized" : "unavailable",
        [brakeCh],
        [
          usableChannel(brakeCh)
            ? "Brake range-normalized on the 60 Hz capture timeline."
            : "MoTeC brake channel unavailable.",
        ],
      ),
      "inputs.steer": sourceEntry(
        "inputs.steer",
        usableChannel(steerCh) ? "assumed" : "absent",
        usableChannel(steerCh) ? "simplified" : "unavailable",
        [steerCh],
        [
          usableChannel(steerCh)
            ? `Steering normalized using assumed ${STEER_LOCK_DEG} degree full lock.`
            : "MoTeC steering channel unavailable.",
        ],
      ),
      "fuel.fuel": sourceEntry(
        "fuel.fuel",
        rateTreatment([fuelCh]),
        usableChannel(fuelCh) ? "direct" : "unavailable",
        [fuelCh],
        [
          usableChannel(fuelCh)
            ? "Fuel samples placed on the 60 Hz capture timeline."
            : "MoTeC fuel channel unavailable.",
        ],
      ),
      "tire.temperature.average": sourceEntry(
        "tire.temperature.average",
        rateTreatment(tyreTempCh),
        availabilityMapping(tyreTempCh, "direct"),
        tyreTempCh,
        [
          "Per-corner tire temperatures placed on the 60 Hz capture timeline; unavailable corners remain non-evidence.",
        ],
      ),
      "tires.tire-wear": sourceEntry(
        "tires.tire-wear",
        "absent",
        "unavailable",
        [],
        ["MoTeC import does not provide tire wear."],
      ),
      "tires.tire-pressure": sourceEntry(
        "tires.tire-pressure",
        rateTreatment(tyrePressCh),
        availabilityMapping(tyrePressCh, "direct"),
        tyrePressCh,
        [
          "Per-corner tire pressures placed on the 60 Hz capture timeline; unavailable corners remain non-evidence.",
        ],
      ),
      "tires.tire-slip-ratio": sourceEntry(
        "tires.tire-slip-ratio",
        "absent",
        "unavailable",
        [],
        ["MoTeC import does not provide tire slip ratio."],
      ),
      "tires.tire-slip-angle": sourceEntry(
        "tires.tire-slip-angle",
        "absent",
        "unavailable",
        [],
        ["MoTeC import does not provide tire slip angle."],
      ),
      "tires.wheel-rotation-speed": sourceEntry(
        "tires.wheel-rotation-speed",
        rateTreatment(wheelSpeedCh),
        availabilityMapping(wheelSpeedCh, "direct"),
        wheelSpeedCh,
        [
          "Per-corner wheel speeds placed on the 60 Hz capture timeline; unavailable corners remain non-evidence.",
        ],
      ),
      "suspension.norm-suspension-travel": sourceEntry(
        "suspension.norm-suspension-travel",
        rateTreatment(suspTravelCh),
        availabilityMapping(suspTravelCh, "direct"),
        suspTravelCh,
        [
          "Per-corner suspension travel placed on the 60 Hz capture timeline; unavailable corners remain non-evidence.",
        ],
      ),
    },
  };

  // --- static page: constant for the whole capture ---
  const staticBuf = Buffer.alloc(STATIC_EVO.SIZE);
  writeCString(staticBuf, STATIC_EVO.sm_version.offset, STATIC_EVO.sm_version.size, "1.0");
  writeCString(staticBuf, STATIC_EVO.ac_evo_version.offset, STATIC_EVO.ac_evo_version.size, "motec");
  staticBuf.writeInt32LE(ACEVO_SESSION_TYPE.AC_HOT_STINT, STATIC_EVO.session.offset);
  writeCString(
    staticBuf,
    STATIC_EVO.session_name.offset,
    STATIC_EVO.session_name.size,
    log.eventSession || "MoTeC import",
  );
  staticBuf.writeInt32LE(1, STATIC_EVO.number_of_sessions.offset);
  writeCString(staticBuf, STATIC_EVO.track.offset, STATIC_EVO.track.size, carTrack.trackName);
  writeCString(staticBuf, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size, "");
  staticBuf.writeFloatLE(lapLengthM, STATIC_EVO.track_length_m.offset);

  // --- frames ---
  const records: Buffer[] = [];
  let bestMs = 0;
  for (let i = 0; i < frames; i++) {
    const lap = lapIndexOf[i]!;
    const [lapStart] = windows[lap]!;
    const lapTimeMs = Math.round((i * dt - lapStart) * 1000);

    // Completed-lap time is the previous window's real duration, and must be
    // fresh on the FIRST frame of the new lap — the detector reads LastLap off
    // the packet that triggers the boundary.
    const prev = lap > 0 ? windows[lap - 1]! : null;
    const lastLapMs = prev ? Math.round((prev[1] - prev[0]) * 1000) : 0;
    if (lastLapMs > 0 && (bestMs === 0 || lastLapMs < bestMs)) bestMs = lastLapMs;

    const physics = Buffer.alloc(PHYSICS.SIZE);
    physics.writeInt32LE(i, PHYSICS.packetId.offset);
    physics.writeFloatLE(throttle[i]!, PHYSICS.gas.offset);
    physics.writeFloatLE(brake[i]!, PHYSICS.brake.offset);
    physics.writeFloatLE(clutch[i]!, PHYSICS.clutch.offset);
    physics.writeFloatLE(fuel[i]!, PHYSICS.fuel.offset);
    // AC encodes gear as 0=R, 1=N, 2=1st; MoTeC logs the real gear with 0=N.
    physics.writeInt32LE(Math.max(0, Math.round(gear[i]!) + 1), PHYSICS.gear.offset);
    physics.writeInt32LE(Math.round(rpm[i]!), PHYSICS.rpms.offset);
    physics.writeFloatLE(
      Math.max(-1, Math.min(1, steerDeg[i]! / STEER_LOCK_DEG)),
      PHYSICS.steerAngle.offset,
    );
    physics.writeFloatLE(speedKmh[i]!, PHYSICS.speedKmh.offset);
    physics.writeFloatLE(gLat[i]!, PHYSICS.accGX.offset);
    physics.writeFloatLE(gLon[i]!, PHYSICS.accGZ.offset);
    physics.writeFloatLE(yawRate[i]!, PHYSICS.localAngularVelY.offset);
    // World-frame velocity, kept consistent with the dead-reckoned path so the
    // parser's player-slot correlation (which matches velocity against
    // coordinate deltas) sees a coherent car.
    physics.writeFloatLE(path.vx[i]!, PHYSICS.velocityX.offset);
    physics.writeFloatLE(path.vz[i]!, PHYSICS.velocityZ.offset);
    physics.writeFloatLE(tc[i]!, PHYSICS.tc.offset);
    physics.writeFloatLE(abs[i]!, PHYSICS.abs.offset);

    const corner = [
      { press: PHYSICS.tyrePressureFL, core: PHYSICS.tyreCoreFL, temp: PHYSICS.tyreTempFL, brake: PHYSICS.brakeTempFL, susp: PHYSICS.suspTravelFL, rot: PHYSICS.wheelRotFL },
      { press: PHYSICS.tyrePressureFR, core: PHYSICS.tyreCoreFR, temp: PHYSICS.tyreTempFR, brake: PHYSICS.brakeTempFR, susp: PHYSICS.suspTravelFR, rot: PHYSICS.wheelRotFR },
      { press: PHYSICS.tyrePressureRL, core: PHYSICS.tyreCoreRL, temp: PHYSICS.tyreTempRL, brake: PHYSICS.brakeTempRL, susp: PHYSICS.suspTravelRL, rot: PHYSICS.wheelRotRL },
      { press: PHYSICS.tyrePressureRR, core: PHYSICS.tyreCoreRR, temp: PHYSICS.tyreTempRR, brake: PHYSICS.brakeTempRR, susp: PHYSICS.suspTravelRR, rot: PHYSICS.wheelRotRR },
    ];
    for (let c = 0; c < 4; c++) {
      physics.writeFloatLE(tyrePress[c]![i]!, corner[c]!.press.offset);
      physics.writeFloatLE(tyreTemp[c]![i]!, corner[c]!.core.offset);
      physics.writeFloatLE(tyreTemp[c]![i]!, corner[c]!.temp.offset);
      physics.writeFloatLE(brakeTemp[c]![i]!, corner[c]!.brake.offset);
      physics.writeFloatLE(suspTravel[c]![i]!, corner[c]!.susp.offset);
      physics.writeFloatLE(wheelSpeed[c]![i]!, corner[c]!.rot.offset);
    }

    const graphics = Buffer.alloc(GRAPHICS_EVO.SIZE);
    graphics.writeInt32LE(i, GRAPHICS_EVO.packetId.offset);
    graphics.writeInt32LE(ACEVO_STATUS.AC_LIVE, GRAPHICS_EVO.status.offset);
    graphics.writeInt32LE(lap, GRAPHICS_EVO.total_lap_count.offset);
    graphics.writeUInt32LE(1, GRAPHICS_EVO.current_pos.offset);
    graphics.writeInt32LE(lapTimeMs, GRAPHICS_EVO.current_lap_time_ms.offset);
    graphics.writeInt32LE(lastLapMs, GRAPHICS_EVO.last_laptime_ms.offset);
    graphics.writeInt32LE(bestMs, GRAPHICS_EVO.best_laptime_ms.offset);
    graphics.writeFloatLE(sessionDistM[i]! / 1000, GRAPHICS_EVO.current_km.offset);
    graphics.writeFloatLE(
      lapLengthM > 0 ? Math.min(1, lapDistM[i]! / lapLengthM) : 0,
      GRAPHICS_EVO.npos.offset,
    );
    graphics.writeInt32LE(ACEVO_CAR_LOCATION.ACEVO_TRACK, GRAPHICS_EVO.car_location.offset);
    graphics.writeUInt8(1, GRAPHICS_EVO.is_valid_lap.offset);
    graphics.writeUInt8(0, GRAPHICS_EVO.is_in_pit_box.offset);
    graphics.writeUInt8(0, GRAPHICS_EVO.is_in_pit_lane.offset);
    graphics.writeUInt8(1, GRAPHICS_EVO.active_cars.offset);
    graphics.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(rpm[i]!))), GRAPHICS_EVO.rpm.offset);
    graphics.writeFloatLE(throttle[i]!, GRAPHICS_EVO.gas_percent.offset);
    graphics.writeFloatLE(brake[i]!, GRAPHICS_EVO.brake_percent.offset);
    graphics.writeFloatLE(clutch[i]!, GRAPHICS_EVO.clutch_percent.offset);
    graphics.writeInt16LE(
      Math.max(-32768, Math.min(32767, Math.round(speedKmh[i]!))),
      GRAPHICS_EVO.display_speed_kmh.offset,
    );
    graphics.writeFloatLE(fuel[i]!, GRAPHICS_EVO.fuel_liter_current_quantity.offset);
    writeCString(
      graphics,
      GRAPHICS_EVO.car_model.offset,
      GRAPHICS_EVO.car_model.size,
      carTrack.carModel,
    );
    writeCString(
      graphics,
      GRAPHICS_EVO.driver_name.offset,
      GRAPHICS_EVO.driver_name.size,
      log.driver,
    );
    // Player car occupies slot 0; `active_cars` is 1 so the parser's slot
    // calibration only ever probes that slot.
    const coordBase = GRAPHICS_EVO.car_coordinates_base.offset;
    graphics.writeFloatLE(path.x[i]!, coordBase);
    graphics.writeFloatLE(0, coordBase + 4);
    graphics.writeFloatLE(path.z[i]!, coordBase + 8);

    const sessBase = GRAPHICS_EVO.session_state_base.offset;
    graphics.writeInt32LE(lap + 1, sessBase + SESSION_STATE.current_lap);
    graphics.writeInt32LE(windows.length, sessBase + SESSION_STATE.total_lap);
    graphics.writeFloatLE(lapLengthM / 1000, sessBase + SESSION_STATE.lap_length_km);

    records.push(
      packTriplet(ACEVO_PACKED_MAGIC, carTrack.carOrdinal, carTrack.trackOrdinal, physics, graphics, staticBuf),
    );
  }

  // --- session-capture framing: meta frame, then [u32 len][frame] records ---
  const meta = encodeMetaFrame(records.length);

  const parts: Buffer[] = [meta];
  for (const rec of records) {
    parts.push(encodeFrameLength(rec.length), rec);
  }

  return {
    bin: Buffer.concat(parts),
    frameCount: records.length,
    lapCount: windows.length,
    carTrack,
    missingChannels,
    yawFromLateralG: path.yawFromLateralG,
    sourceChannelProfile,
  };
}
