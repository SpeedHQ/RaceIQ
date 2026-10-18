import type { ComparisonData } from "@raceiq/shared/racing/comparison/types";
import type { SemanticLapTelemetry, SemanticReplayFrame } from "@/hooks/laps";
import { hasTelemetryGap } from "@/components/analyse/AnalyseTelemetryChart";
import type { SpectateController, SpectateLap, SpectatePose, SpectateReading, SpectateSample, SpectateSnapshot } from "@/components/comparison/spectate/types";

const SEGMENT_SEEK_DURATION_MS = 1200;
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const validEntry = (value: SemanticReplayFrame["values"][number]) => (value.state == null || value.state === "ok") && (value.freshness == null || value.freshness === "fresh");
function numericShape(value: unknown): unknown {
  if (number(value) !== null) return value;
  if (Array.isArray(value)) return value.map(numericShape);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, numericShape(item)]));
  return null;
}
function interpolateShape(left: unknown, right: unknown, fraction: number): unknown {
  const a = number(left),
    b = number(right);
  if (a !== null && b !== null) return a + (b - a) * fraction;
  if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) return left.map((value, index) => interpolateShape(value, right[index], fraction));
  if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
    const other = right as Record<string, unknown>;
    return Object.fromEntries(Object.entries(left).map(([key, value]) => [key, interpolateShape(value, other[key], fraction)]));
  }
  return null;
}
function lowerBound<T>(items: readonly T[], target: number, value: (item: T) => number): number {
  let lo = 0,
    hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (value(items[mid]!) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Register native samples to their own aligned path without moving recorded poses. */
export function prepareSpectateLap(replay: SemanticLapTelemetry, comparison: ComparisonData, side: "a" | "b"): SpectateLap {
  const traces = comparison.traces;
  const elapsed = side === "a" ? traces.elapsedTimeA : traces.elapsedTimeB;
  const aligned: Array<{ time: number; distance: number; first: number; last: number }> = [];
  for (let index = 0; index < elapsed.length; index++) {
    const time = elapsed[index]!,
      distance = traces.distance[index]!;
    if (!Number.isFinite(time) || !Number.isFinite(distance)) continue;
    const previous = aligned.at(-1);
    if (!previous || time > previous.time) aligned.push({ time, distance, first: index, last: index });
    else if (time === previous.time) previous.last = index;
  }
  const positionX = side === "a" ? traces.positionXA : traces.positionXB;
  const positionZ = side === "a" ? traces.positionZA : traces.positionZB;
  const hasAlignedPath = positionX?.length === traces.distance.length && positionZ?.length === traces.distance.length;
  const projectDistance = (time: number, index: number, x: number, z: number): number | null => {
    if (!hasAlignedPath || aligned.length < 2) return null;
    let first = Math.max(0, Math.min(aligned.length - 2, index - 1));
    let last = Math.min(aligned.length - 1, index);
    while (first > 0 && !hasTelemetryGap(aligned[first - 1]!.time, time)) first--;
    while (last + 1 < aligned.length && !hasTelemetryGap(time, aligned[last + 1]!.time)) last++;
    let bestError = Infinity, bestDistance: number | null = null, tolerance = 0;
    for (let segment = aligned[first]!.first; segment < aligned[last]!.last; segment++) {
      const ax = positionX[segment]!, az = positionZ[segment]!;
      const dx = positionX[segment + 1]! - ax, dz = positionZ[segment + 1]! - az;
      const lengthSquared = dx * dx + dz * dz;
      if (!(lengthSquared > 0) || !Number.isFinite(lengthSquared)) continue;
      const fraction = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSquared));
      const error = (x - ax - fraction * dx) ** 2 + (z - az - fraction * dz) ** 2;
      if (error < bestError) {
        bestError = error;
        const span = traces.distance[segment + 1]! - traces.distance[segment]!;
        bestDistance = traces.distance[segment]! + fraction * span;
        tolerance = Math.max(0.25, span);
      }
    }
    // Reject unrelated coordinate frames; never fit or offset either racing line.
    return bestError <= tolerance * tolerance ? bestDistance : null;
  };
  const readNumber = (frame: SemanticReplayFrame, id: string) => {
    const entry = frame.values.find((item) => item.semanticId === id);
    return entry && validEntry(entry) ? number(entry.value) : null;
  };
  const firstObserved = replay.envelopes.find((frame) => Number.isFinite(frame.observedAt.milliseconds))?.observedAt;
  let clockAdvances = false,
    previousNative: number | null = null;
  for (const frame of replay.envelopes) {
    const native = readNumber(frame, "timing.current-lap");
    if (native !== null && previousNative !== null && native > previousNative + 0.001) {
      clockAdvances = true;
      break;
    }
    if (native !== null) previousNative = native;
  }
  let nativeOrigin: number | null = null;
  for (const frame of clockAdvances ? replay.envelopes : []) {
    const native = readNumber(frame, "timing.current-lap");
    if (native === null || native < 0) continue;
    const observedElapsed = firstObserved && frame.observedAt.domain === firstObserved.domain ? (frame.observedAt.milliseconds - firstObserved.milliseconds) / 1000 : 0;
    nativeOrigin = native - Math.max(0, observedElapsed);
    break;
  }
  let traveledOrigin: number | null = null,
    previousTime = -Infinity,
    run = 0,
    maxDistance = 0;
  const samples: SpectateSample[] = [];
  for (const frame of replay.envelopes) {
    const native = readNumber(frame, "timing.current-lap");
    const observed = firstObserved && frame.observedAt.domain === firstObserved.domain ? (frame.observedAt.milliseconds - firstObserved.milliseconds) / 1000 : null;
    const time = native !== null && native >= 0 && nativeOrigin !== null ? native - nativeOrigin : observed;
    if (time === null || !Number.isFinite(time) || time < 0) {
      run++;
      continue;
    }
    // A reset starts another lap/interval. Do not splice it into this recording.
    if (time < previousTime - 0.001) break;
    if (hasTelemetryGap(previousTime, time)) run++;
    const values: Record<string, unknown> = {};
    for (const entry of frame.values) {
      values[entry.semanticId] = validEntry(entry) ? (entry.semanticId === "fuel.ers-deploy-mode" ? entry.value : numericShape(entry.value)) : null;
    }
    const traveled = number(values["timing.distance-traveled"]);
    let distance = NaN;
    const index = lowerBound(aligned, time, (point) => point.time);
    const exact = aligned[index],
      before = aligned[index - 1];
    if (exact?.time === time) distance = exact.distance;
    else if (before && exact) distance = before.distance + ((exact.distance - before.distance) * (time - before.time)) / (exact.time - before.time);
    else if (aligned.length < 2 && traveled !== null) {
      // Retain a native distance readout, but it cannot establish shared track progress.
      traveledOrigin ??= traveled;
      distance = traveled - traveledOrigin;
    }
    const x = number(values["motion.position-x"]), z = number(values["motion.position-z"]);
    if (x !== null && z !== null) distance = projectDistance(time, index, x, z) ?? distance;
    if (Number.isFinite(distance)) maxDistance = Math.max(maxDistance, distance);
    const sample = { time, distance, run, values };
    // Coalesced ticks replace the same instant, without creating a zero interval.
    if (samples.at(-1)?.time === time) samples[samples.length - 1] = sample;
    else samples.push(sample);
    previousTime = time;
  }
  // F1 lap-data and motion arrive independently. A held pose on a new lap tick
  // is not a stop: retain its telemetry, but interpolate motion to the next update.
  const motionSamples = replay.envelopes[0]?.simulator === "f1-2025" ? samples.filter((sample, index) => {
    const previous = samples[index - 1];
    if (!previous || index === samples.length - 1 || previous.run !== sample.run || !poseOf(sample.values) || !poseOf(previous.values) || !(Number(sample.values["motion.speed"]) > 0) || !(Number(previous.values["motion.speed"]) > 0)) return true;
    return ["motion.position-x", "motion.position-y", "motion.position-z", "motion.yaw"].some((key) => sample.values[key] !== previous.values[key]);
  }) : undefined;
  let lastDistance = -Infinity,
    progressCount = 0,
    monotonic = true;
  for (const sample of motionSamples ?? samples) {
    if (!Number.isFinite(sample.distance)) continue;
    if (sample.distance < lastDistance - 0.01) monotonic = false;
    if (sample.distance > lastDistance) progressCount++;
    lastDistance = sample.distance;
  }
  return { samples, motionSamples, duration: samples.at(-1)?.time ?? 0, distance: maxDistance, hasProgress: aligned.length > 1 && monotonic && progressCount > 1, replay };
}

function poseOf(values: Readonly<Record<string, unknown>>): SpectatePose | null {
  const x = number(values["motion.position-x"]),
    z = number(values["motion.position-z"]),
    yaw = number(values["motion.yaw"]);
  if (x === null || z === null || yaw === null) return null;
  return { x, y: number(values["motion.position-y"]) ?? 0, z, yaw };
}
function sampleMotion(samples: readonly SpectateSample[], time: number, holdPose: boolean): Pick<SpectateReading, "pose" | "distance"> {
  const first = samples[0], last = samples.at(-1);
  if (!first || !last || time < first.time) return { pose: null, distance: null };
  if (time > last.time) return { pose: holdPose ? poseOf(last.values) : null, distance: holdPose && Number.isFinite(last.distance) ? last.distance : null };
  const index = lowerBound(samples, time, (sample) => sample.time), right = samples[index]!;
  if (right.time === time) return { pose: poseOf(right.values), distance: Number.isFinite(right.distance) ? right.distance : null };
  const left = samples[index - 1];
  if (!left || left.run !== right.run || hasTelemetryGap(left.time, right.time)) return { pose: null, distance: null };
  const a = poseOf(left.values), b = poseOf(right.values);
  if (!a || !b) return { pose: null, distance: null };
  const fraction = (time - left.time) / (right.time - left.time);
  return {
    pose: {
      x: a.x + (b.x - a.x) * fraction,
      y: a.y + (b.y - a.y) * fraction,
      z: a.z + (b.z - a.z) * fraction,
      yaw: a.yaw + Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)) * fraction,
    },
    distance: Number.isFinite(left.distance) && Number.isFinite(right.distance) ? left.distance + (right.distance - left.distance) * fraction : null,
  };
}
function sampleLap(lap: SpectateLap, time: number, holdPose: boolean): SpectateReading | null {
  const samples = lap.samples,
    first = samples[0],
    last = samples.at(-1);
  if (!first || !last || time < first.time) return null;
  if (time > last.time) return holdPose ? { time: last.time, distance: Number.isFinite(last.distance) ? last.distance : null, pose: poseOf(last.values), values: {} } : null;
  const index = lowerBound(samples, time, (sample) => sample.time);
  const right = samples[index]!;
  if (right.time === time) return { time, distance: Number.isFinite(right.distance) ? right.distance : null, pose: poseOf(right.values), values: right.values };
  const left = samples[index - 1];
  if (!left || left.run !== right.run || hasTelemetryGap(left.time, right.time)) return null;
  const fraction = (time - left.time) / (right.time - left.time);
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(left.values)) {
    const a = left.values[key],
      b = right.values[key];
    if (key === "inputs.gear" || key === "fuel.ers-deploy-mode") values[key] = a;
    else if (key === "motion.yaw" && number(a) !== null && number(b) !== null) {
      const delta = Math.atan2(Math.sin(Number(b) - Number(a)), Math.cos(Number(b) - Number(a)));
      values[key] = Number(a) + delta * fraction;
    } else values[key] = interpolateShape(a, b, fraction);
  }
  const distance = Number.isFinite(left.distance) && Number.isFinite(right.distance) ? left.distance + (right.distance - left.distance) * fraction : null;
  return { time, distance, pose: poseOf(values), values };
}

/** Equal-distance samples retain plateau departure; lowerBound still finds earliest arrival. */
function progressIndex(lap: SpectateLap): readonly SpectateSample[] {
  const index: SpectateSample[] = [];
  for (const sample of lap.motionSamples ?? lap.samples) {
    if (!Number.isFinite(sample.distance) || (index.length && sample.distance < index.at(-1)!.distance)) continue;
    index.push(sample);
  }
  return index;
}
function arrivalAt(index: readonly SpectateSample[], distance: number): number | null {
  const first = index[0],
    last = index.at(-1);
  if (!first || !last || distance < first.distance || distance > last.distance) return null;
  const found = lowerBound(index, distance, (sample) => sample.distance),
    right = index[found]!;
  if (right.distance === distance) return right.time;
  const left = index[found - 1];
  if (!left || left.run !== right.run || hasTelemetryGap(left.time, right.time)) return null;
  return left.time + ((right.time - left.time) * (distance - left.distance)) / (right.distance - left.distance);
}

/** One demand-driven driver owns clock, transition, play intent, and subscribers. */
export function createSpectateController(a: SpectateLap, b: SpectateLap, initialDistance?: number, fpsCap: number | (() => number) = 30): SpectateController {
  const duration = Math.max(a.duration, b.duration),
    listeners = new Set<() => void>();
  const aProgress = progressIndex(a),
    bProgress = progressIndex(b);
  const canLock = a.hasProgress && b.hasProgress;
  let time = initialDistance == null ? 0 : (arrivalAt(aProgress, initialDistance) ?? 0);
  let playing = false,
    speed = 1,
    positionLock = canLock,
    active = false,
    disposed = false,
    generation = 0;
  let raf = 0,
    previousFrame: number | null = null;
  let transition: { from: number; to: number; start: number } | null = null;
  let snapshot: SpectateSnapshot;
  const read = (target: number, holdPose = true) => {
    const ra = sampleLap(a, target, holdPose);
    if (ra && a.motionSamples) Object.assign(ra, sampleMotion(a.motionSamples, target, holdPose));
    if (!positionLock) {
      const rb = sampleLap(b, target, holdPose);
      if (rb && b.motionSamples) Object.assign(rb, sampleMotion(b.motionSamples, target, holdPose));
      return { a: ra, b: rb };
    }
    const bTime = ra?.distance == null ? null : arrivalAt(bProgress, ra.distance);
    const rb = bTime === null ? null : sampleLap(b, bTime, holdPose);
    if (rb && b.motionSamples && bTime !== null) Object.assign(rb, sampleMotion(b.motionSamples, bTime, holdPose));
    return { a: ra, b: rb };
  };
  const timeAt = (now: number) => {
    if (!active || disposed) return time;
    if (transition) {
      const progress = Math.min(1, Math.max(0, (now - transition.start) / SEGMENT_SEEK_DURATION_MS));
      const eased = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      return progress === 1 ? transition.to : transition.from + (transition.to - transition.from) * eased;
    }
    return playing && previousFrame !== null ? Math.min(duration, time + (Math.max(0, now - previousFrame) / 1000) * speed) : time;
  };
  const publish = () => {
    generation++;
    snapshot = { time, duration, playing, speed, positionLock, canLock, seeking: transition !== null, generation, ...read(time) };
    for (const listener of listeners) listener();
  };
  const cancelFrame = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    previousFrame = null;
  };
  const stop = () => {
    cancelFrame();
    transition = null;
  };
  const frame = (now: number) => {
    raf = 0;
    if (disposed || !active || (typeof document !== "undefined" && document.hidden)) return;
    const cap = typeof fpsCap === "function" ? fpsCap() : fpsCap;
    const interval = 1000 / (Number.isFinite(cap) && cap > 0 ? cap : 60);
    if (previousFrame === null || now - previousFrame >= interval - 0.5) {
      time = timeAt(now);
      if (transition) {
        if (now - transition.start >= SEGMENT_SEEK_DURATION_MS) transition = null;
      } else if (playing && time >= duration) {
        playing = false;
      }
      previousFrame = now;
      publish();
    }
    if (playing || transition) raf = requestAnimationFrame(frame);
  };
  const start = () => {
    if (!disposed && !raf && active && (playing || transition)) raf = requestAnimationFrame(frame);
  };
  const visibility = () => {
    if (document.hidden) {
      time = timeAt(performance.now());
      playing = false;
      stop();
      publish();
    }
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility);
  publish();
  return {
    getSnapshot: () => snapshot,
    getFrameSnapshot: (now) => {
      const frameTime = timeAt(now);
      return frameTime === snapshot.time ? snapshot : { ...snapshot, time: frameTime, ...read(frameTime) };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    play: () => {
      if (disposed || !active || playing) return;
      if (time >= duration) time = 0;
      previousFrame = performance.now();
      playing = true;
      start();
      publish();
    },
    pause: () => {
      time = timeAt(performance.now());
      playing = false;
      stop();
      publish();
    },
    scrub: (target) => {
      stop();
      if (Number.isFinite(target)) time = Math.max(0, Math.min(duration, target));
      publish();
      start();
    },
    seekDistance: (distance, immediate = false) => {
      const target = arrivalAt(aProgress, distance);
      if (target === null || disposed) return;
      const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (immediate || reduced) {
        stop();
        time = target;
        publish();
        start();
      } else {
        const now = performance.now();
        time = timeAt(now);
        transition = { from: time, to: target, start: now };
        start();
        publish();
      }
    },
    setSpeed: (value) => {
      if (Number.isFinite(value) && value > 0) {
        const now = performance.now();
        time = timeAt(now);
        if (previousFrame !== null) previousFrame = now;
        speed = value;
      }
      publish();
    },
    setPositionLock: (locked) => {
      positionLock = locked && canLock;
      publish();
    },
    setActive: (value) => {
      if (!value) time = timeAt(performance.now());
      active = value;
      if (!active) {
        playing = false;
        stop();
      } else start();
      publish();
    },
    dispose: () => {
      disposed = true;
      playing = false;
      stop();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibility);
      listeners.clear();
    },
    sample: (target, holdPose = false) => read(target, holdPose),
  };
}
