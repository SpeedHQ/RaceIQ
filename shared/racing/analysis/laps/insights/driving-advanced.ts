import type { TelemetryPacket } from "../../../../telemetry/types";
import type { LapPathPoint } from "../../../tracks/path";
import { reportableLoss, accelDeficitLoss, sumLosses } from "../time-loss";
import { steerBalance, steerBalanceFromSignals, type SteerBalance } from "../physics/vehicle";
import { eventDurations, eventSeconds, groupEvents, midFrame, type RacingLineReference, type TimeLossCtx } from "./types";
import type { LapInsight } from "./types";

function balanceForPacket(packet: TelemetryPacket, physicalSlipAngles: boolean): SteerBalance {
  if (physicalSlipAngles) return steerBalance(packet);
  return steerBalanceFromSignals({
    speedMps: packet.Speed,
    accelerationX: packet.AccelerationX,
    yawRate: packet.AngularVelocityY,
  });
}

export function detectBrakeDrag(telemetry: TelemetryPacket[]): LapInsight | null {
  // Flag frames where throttle is applied AND brake is lightly applied simultaneously
  const flags = telemetry.map((p) => {
    const throttle = p.Accel / 255;
    const brake = p.Brake / 255;
    // Throttle > 50% with light brake (0.5-25%) — not intentional trail braking or hard braking
    return throttle > 0.5 && brake > 0.005 && brake < 0.25;
  });

  const dt = eventDurations(telemetry);
  const events = groupEvents(flags, dt, 0.25);
  if (events.length === 0) return null;

  const totalSeconds = events.reduce((seconds, [start, end]) => seconds + eventSeconds(dt, start, end, flags), 0);

  return {
    id: "driving-brake-drag",
    category: "driving",
    severity: totalSeconds > 3 ? "critical" : totalSeconds > 1 ? "warning" : "info",
    label: "Brake Drag",
    detail: `Brake applied while on full throttle ${events.length} time${events.length > 1 ? "s" : ""} (${totalSeconds.toFixed(1)}s total). Check foot position — resting on the brake pedal costs straight-line speed.`,
    frameIndices: midFrame(events),
  };
}

export function detectDownshiftOverRev(telemetry: TelemetryPacket[]): LapInsight | null {
  // Downshift that sends the engine near the limiter — too aggressive, risks
  // rear lockup from engine braking and over-rev damage.
  if (telemetry.length === 0) return null;
  const maxRpm = telemetry[0].EngineMaxRpm;
  if (maxRpm === 0) return null;

  const dt = eventDurations(telemetry);
  const eventFrames: number[] = [];
  let elapsed = 0;
  let lastEvent = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < telemetry.length; i++) {
    if (dt[i - 1] <= 0) {
      lastEvent = Number.NEGATIVE_INFINITY;
      continue;
    }
    elapsed += dt[i - 1];
    const prev = telemetry[i - 1];
    const cur = telemetry[i];
    if (!(cur.Gear > 0 && prev.Gear > cur.Gear) || elapsed - lastEvent + 1e-9 < 1) continue;
    // RPM spike within 0.3s of the downshift, never across missing telemetry.
    let lookahead = 0;
    for (let j = i; j < telemetry.length && lookahead < 0.3 - 1e-9; j++) {
      if (dt[j] <= 0) break;
      if (telemetry[j].CurrentEngineRpm >= maxRpm * 0.97) {
        eventFrames.push(j);
        lastEvent = elapsed;
        break;
      }
      lookahead += dt[j];
    }
  }

  if (eventFrames.length === 0) return null;
  return {
    id: "driving-downshift-over-rev",
    category: "driving",
    severity: eventFrames.length >= 4 ? "warning" : "info",
    label: "Aggressive Downshifts",
    detail: `${eventFrames.length} downshift${eventFrames.length > 1 ? "s" : ""} spiked RPM near the limiter — shift down later to avoid engine-braking lockups`,
    frameIndices: eventFrames,
  };
}

const RACING_LINE_OUTSIDE_M = 1.5;
const RACING_LINE_GROWTH_M = 1;
const RACING_LINE_MAX_PROJECTION_M = 12;

function racingLineOutsideOffsets(telemetry: TelemetryPacket[], racingLine: readonly LapPathPoint[], dt: readonly number[]): { offsets: (number | undefined)[]; directions: number[] } | null {
  if (racingLine.length < 20) return null;

  const segmentCount = racingLine.length;
  const offsets = new Array<number | undefined>(telemetry.length);
  const directions = new Array<number>(telemetry.length).fill(0);
  let previousSegment = -1;

  for (let frame = 0; frame < telemetry.length; frame++) {
    if (frame > 0 && dt[frame - 1] <= 0) previousSegment = -1;
    const packet = telemetry[frame];
    const px = packet.PositionX;
    const pz = packet.PositionZ;
    if (!Number.isFinite(px) || !Number.isFinite(pz) || (px === 0 && pz === 0)) continue;

    let bestSegment = -1;
    let bestDistanceSquared = Number.POSITIVE_INFINITY;
    let bestProjectionX = 0;
    let bestProjectionZ = 0;

    let searchAll = previousSegment < 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const first = searchAll ? 0 : -16;
      const last = searchAll ? segmentCount - 1 : 256;
      for (let candidate = first; candidate <= last; candidate++) {
        const segment = searchAll ? candidate : previousSegment + candidate;
        const index = ((segment % segmentCount) + segmentCount) % segmentCount;
        const nextIndex = (index + 1) % segmentCount;
        const start = racingLine[index];
        const end = racingLine[nextIndex];
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const lengthSquared = dx * dx + dz * dz;
        if (!(lengthSquared > 0)) continue;
        const amount = Math.max(0, Math.min(1, ((px - start.x) * dx + (pz - start.z) * dz) / lengthSquared));
        const projectionX = start.x + dx * amount;
        const projectionZ = start.z + dz * amount;
        const distanceSquared = (px - projectionX) ** 2 + (pz - projectionZ) ** 2;
        if (distanceSquared >= bestDistanceSquared) continue;
        bestSegment = index;
        bestDistanceSquared = distanceSquared;
        bestProjectionX = projectionX;
        bestProjectionZ = projectionZ;
      }

      if (searchAll || bestDistanceSquared <= RACING_LINE_MAX_PROJECTION_M ** 2) break;
      searchAll = true;
    }

    if (bestSegment < 0 || bestDistanceSquared > RACING_LINE_MAX_PROJECTION_M ** 2) continue;
    previousSegment = bestSegment;

    const lookback = Math.min(12, Math.floor(segmentCount / 4));
    const before = racingLine[(bestSegment - lookback + segmentCount) % segmentCount];
    const start = racingLine[bestSegment];
    const end = racingLine[(bestSegment + 1) % segmentCount];
    const after = racingLine[(bestSegment + 1 + lookback) % segmentCount];
    const incomingX = start.x - before.x;
    const incomingZ = start.z - before.z;
    const outgoingX = after.x - end.x;
    const outgoingZ = after.z - end.z;
    const incomingLength = Math.hypot(incomingX, incomingZ);
    const outgoingLength = Math.hypot(outgoingX, outgoingZ);
    if (!(incomingLength > 0) || !(outgoingLength > 0)) continue;
    const curvature = (incomingX * outgoingZ - incomingZ * outgoingX) / (incomingLength * outgoingLength);
    if (Math.abs(curvature) < 0.015) continue;

    const tangentX = end.x - start.x;
    const tangentZ = end.z - start.z;
    const tangentLength = Math.hypot(tangentX, tangentZ);
    if (!(tangentLength > 0)) continue;
    const signedLateral = (tangentX * (pz - bestProjectionZ) - tangentZ * (px - bestProjectionX)) / tangentLength;
    offsets[frame] = -Math.sign(curvature) * signedLateral;
    directions[frame] = Math.sign(curvature);
  }

  return { offsets, directions };
}

export function detectLateBrakingOvershoot(telemetry: TelemetryPacket[], physicalSlipAngles = true, racingLine?: RacingLineReference): LapInsight | null {
  // Judge reference availability within each braking corner. Straight-heavy laps
  // must not erase usable geometry, nor turn a stable alternative line into scrub.
  const dt = eventDurations(telemetry);
  const projection = racingLine?.source === "track-data" ? racingLineOutsideOffsets(telemetry, racingLine.points, dt) : null;
  const brakeFlags = telemetry.map((packet) => packet.Brake > 25);
  const brakeZones = groupEvents(brakeFlags, dt, 5 / 60, 10 / 60);
  const cornerZones: [number, number][] = [];
  for (const [start, end] of brakeZones) {
    let cornerStart = start;
    let direction = 0;
    for (let i = start; i <= end; i++) {
      const nextDirection = projection?.directions[i] ?? 0;
      if (nextDirection === 0) continue;
      if (direction !== 0 && direction !== nextDirection) {
        cornerZones.push([cornerStart, i - 1]);
        cornerStart = i;
      }
      direction = nextDirection;
    }
    cornerZones.push([cornerStart, end]);
  }

  const events: [number, number][] = [];
  let geometricEvents = 0;
  for (const [start, end] of cornerZones) {
    let candidateSeconds = 0;
    let geometricSeconds = 0;
    for (let i = start; i <= end; i++) {
      const packet = telemetry[i];
      if (packet.Brake <= 90 || Math.abs(packet.Steer) <= 35 || packet.Speed * 2.23694 <= 30) continue;
      candidateSeconds += dt[i];
      if (projection?.offsets[i] !== undefined) geometricSeconds += dt[i];
    }
    const useGeometry = geometricSeconds + 1e-9 >= 10 / 60 && geometricSeconds >= candidateSeconds * 0.5;
    let minimumOutside = Number.POSITIVE_INFINITY;
    let overlapSeconds = 0;
    let longestOverlap = 0;
    let peakFrame = start;
    for (let i = start; i <= end; i++) {
      const outside = projection?.offsets[i];
      if (outside === undefined || dt[i] <= 0) minimumOutside = Number.POSITIVE_INFINITY;
      else minimumOutside = Math.min(minimumOutside, outside);

      const packet = telemetry[i];
      let overshooting = false;
      if (dt[i] > 0 && packet.Brake > 90 && Math.abs(packet.Steer) > 35 && packet.Speed * 2.23694 > 30) {
        if (useGeometry) {
          overshooting = outside !== undefined && outside > RACING_LINE_OUTSIDE_M && outside - minimumOutside > RACING_LINE_GROWTH_M;
        } else if (outside === undefined) {
          // Known geometry showing no departure is not missing evidence.
          const balance = balanceForPacket(packet, physicalSlipAngles);
          overshooting = balance.state === "understeer" && balance.severity > 0.3;
        }
      }

      if (overshooting) {
        overlapSeconds += dt[i];
        if (overlapSeconds > longestOverlap) {
          longestOverlap = overlapSeconds;
          peakFrame = i;
        }
      } else {
        overlapSeconds = 0;
      }
    }
    if (longestOverlap + 1e-9 >= 10 / 60) {
      events.push([start, peakFrame]);
      if (useGeometry) geometricEvents++;
    }
  }

  if (events.length === 0) return null;
  const evidence = geometricEvents === events.length
    ? "braking carried the car progressively outside the reference racing line"
    : geometricEvents === 0
      ? "still braking hard with heavy steering and front scrub"
      : `${geometricEvents} departed the reference racing line; the others combined hard braking, heavy steering and front scrub where geometry was unavailable`;
  return {
    id: "driving-late-braking-overshoot",
    category: "driving",
    severity: events.length >= 3 ? "warning" : "info",
    label: "Late Braking Overshoot",
    detail: `${events.length} corner${events.length > 1 ? "s" : ""} — ${evidence}. Brake earlier or release sooner to rotate.`,
    frameIndices: events.map(([, peak]) => peak),
  };
}

export function detectUndersteerScrub(telemetry: TelemetryPacket[], physicalSlipAngles = true): LapInsight | null {
  // Sustained understeer mid-corner: lots of steering, front slip well above
  // rear — the fronts are sliding, adding steering won't help.
  const flags = telemetry.map((p) => {
    if (p.Speed * 2.23694 < 30 || Math.abs(p.Steer) < 25) return false;
    const bal = balanceForPacket(p, physicalSlipAngles);
    return bal.state === "understeer" && bal.severity > 0.4;
  });
  const dt = eventDurations(telemetry);
  const events = groupEvents(flags, dt, 10 / 60, 20 / 60);
  if (events.length === 0) return null;
  const totalSeconds = events.reduce((seconds, [start, end]) => seconds + eventSeconds(dt, start, end, flags), 0);
  return {
    id: "driving-understeer-scrub",
    category: "driving",
    severity: events.length >= 4 || totalSeconds > 3 ? "warning" : "info",
    label: "Understeer Scrub",
    detail: `${events.length} corner${events.length > 1 ? "s" : ""} with sustained front scrub (${totalSeconds.toFixed(1)}s total) — slow entry slightly or open the steering to regain front grip`,
    frameIndices: midFrame(events),
  };
}

export function detectOversteerSlide(telemetry: TelemetryPacket[], physicalSlipAngles = true): LapInsight | null {
  const flags = telemetry.map((p) => {
    if (p.Speed * 2.23694 < 30 || Math.abs(p.Steer) < 15) return false;
    const balance = balanceForPacket(p, physicalSlipAngles);
    return balance.state === "oversteer" && balance.severity > 0.4;
  });
  const dt = eventDurations(telemetry);
  const events = groupEvents(flags, dt, 10 / 60, 20 / 60);
  if (events.length === 0) return null;
  const totalSeconds = events.reduce((seconds, [start, end]) => seconds + eventSeconds(dt, start, end, flags), 0);
  return {
    id: "driving-oversteer-slide",
    category: "driving",
    severity: events.length >= 4 || totalSeconds > 3 ? "warning" : "info",
    label: "Oversteer Slide",
    detail: `${events.length} corner${events.length > 1 ? "s" : ""} with sustained rear slip — reduce entry speed or feed throttle more progressively`,
    frameIndices: midFrame(events),
  };
}

export function detectSteeringSawing(telemetry: TelemetryPacket[]): LapInsight | null {
  // High-frequency steering reversals mid-corner — fighting the car or
  // overdriving. Count direction flips of the steering derivative.
  const dt = eventDurations(telemetry);
  const reversal: boolean[] = new Array(telemetry.length).fill(false);
  let lastDir = 0;
  for (let i = 1; i < telemetry.length; i++) {
    const p = telemetry[i];
    if (dt[i - 1] <= 0 || dt[i] <= 0 || Math.abs(p.Steer) < 15 || p.Speed * 2.23694 < 40) {
      lastDir = 0;
      continue;
    }
    const d = (p.Steer - telemetry[i - 1].Steer) / dt[i - 1];
    if (Math.abs(d) < 300) continue; // input units/s, formerly 5 units at 60 Hz
    const dir = Math.sign(d);
    if (lastDir !== 0 && dir !== lastDir) reversal[i] = true;
    lastDir = dir;
  }

  // Flag windows with ≥4 reversals per second
  const flags: boolean[] = new Array(telemetry.length).fill(false);
  let count = 0;
  let windowStart = 0;
  let windowSeconds = 0;
  for (let i = 0; i < telemetry.length; i++) {
    if (dt[i] <= 0 || (i > 0 && dt[i - 1] <= 0) || Math.abs(telemetry[i].Steer) < 15 || telemetry[i].Speed * 2.23694 < 40) {
      count = 0;
      windowStart = i + 1;
      windowSeconds = 0;
      continue;
    }
    if (i > windowStart) windowSeconds += dt[i - 1];
    while (windowStart < i && windowSeconds >= 1) {
      if (reversal[windowStart]) count--;
      windowSeconds -= dt[windowStart++];
    }
    if (reversal[i]) count++;
    if (count >= 4) flags[i] = true;
  }
  const events = groupEvents(flags, dt, 10 / 60, 0.5);
  if (events.length === 0) return null;
  return {
    id: "driving-steering-sawing",
    category: "driving",
    severity: events.length >= 3 ? "warning" : "info",
    label: "Steering Sawing",
    detail: `${events.length} zone${events.length > 1 ? "s" : ""} of rapid steering corrections — smooth the inputs; sawing scrubs speed and unsettles the car`,
    frameIndices: midFrame(events),
  };
}

export function detectThrottleMicroLifts(telemetry: TelemetryPacket[], ctx?: TimeLossCtx): LapInsight | null {
  // Repeated small throttle lifts under power with the rear breaking loose —
  // manually doing traction control's job. Signature: near-full throttle,
  // sharp dip, quick recovery, with wheelspin nearby.
  const wheelStates = ctx?.wheelStates;
  if (!wheelStates) return null;
  const dt = eventDurations(telemetry);
  const liftFrames: number[] = [];
  const liftWindows: [number, number][] = [];
  let i = 1;
  while (i < telemetry.length - 1) {
    const cur = telemetry[i];
    if (dt[i] <= 0 || cur.Brake > 25) {
      i++;
      continue;
    }
    // Compare with recent throttle, not a single sample: a sharp physical lift
    // may be spread over several samples on a high-rate stream.
    let onset = -1;
    let lookback = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (dt[j] <= 0 || telemetry[j].Brake > 25) break;
      lookback += dt[j];
      if (lookback > 0.1 + 1e-9) break;
      if (telemetry[j].Accel > 180 && telemetry[j].Accel - cur.Accel >= 60) {
        onset = j;
        break;
      }
    }
    if (onset < 0) {
      i++;
      continue;
    }

    let recovered = -1;
    let lookahead = dt[i];
    for (let j = i + 1; j < telemetry.length && lookahead <= 20 / 60 + 1e-9; j++) {
      if (dt[j] <= 0 || telemetry[j].Brake > 25) break;
      if (telemetry[j].Accel >= telemetry[onset].Accel - 30) {
        recovered = j;
        break;
      }
      lookahead += dt[j];
    }
    if (recovered < 0) {
      i++;
      continue;
    }

    // Require calibrated rear spin within 1/6s of the lift/recovery. Idle or
    // absent wheel states cannot establish traction loss.
    let slipStart = i;
    let slipEnd = recovered;
    let nearbySeconds = 0;
    while (slipStart > 0 && dt[slipStart - 1] > 0 && nearbySeconds + dt[slipStart - 1] <= 10 / 60 + 1e-9) {
      nearbySeconds += dt[--slipStart];
    }
    nearbySeconds = 0;
    while (slipEnd + 1 < telemetry.length && dt[slipEnd] > 0 && nearbySeconds + dt[slipEnd] <= 10 / 60 + 1e-9) {
      nearbySeconds += dt[slipEnd++];
    }
    for (let j = slipStart; j <= slipEnd; j++) {
      if (dt[j] <= 0) continue;
      const ws = wheelStates[j];
      if (ws?.rl.state === "spin" || ws?.rr.state === "spin") {
        liftFrames.push(i);
        liftWindows.push([onset, recovered]);
        break;
      }
    }
    i = recovered + 1;
  }

  if (liftFrames.length < 4) return null;
  return {
    id: "driving-throttle-micro-lifts",
    category: "driving",
    severity: liftFrames.length >= 8 ? "warning" : "info",
    label: "Throttle Micro-Lifts",
    detail: `${liftFrames.length} quick lifts under power with rear slip — feeding throttle more progressively beats stabbing and lifting`,
    frameIndices: liftFrames,
    // Each lift-and-recover window is time the car spent accelerating worse than
    // this car demonstrably accelerates at that speed. Charged against the
    // acceleration reference, not against the wheelspin that provoked the lift —
    // the two overlap, which is why these numbers must never be summed.
    timeLossS: ctx ? reportableLoss(sumLosses(liftWindows.map(([s, e]) => accelDeficitLoss(telemetry, ctx.dt, s, e, ctx.ref)))) : undefined,
  };
}

export function detectKerbRiding(telemetry: TelemetryPacket[]): LapInsight | null {
  // Hard kerb strikes: wheel on a rumble strip (when the game reports it)
  // combined with a sharp suspension compression spike at speed. Games that
  // don't report rumble strips (F1, AC Evo) fall back to the spike alone.
  const hasRumble = telemetry.some((p) => p.WheelOnRumbleStripFL > 0 || p.WheelOnRumbleStripFR > 0 || p.WheelOnRumbleStripRL > 0 || p.WheelOnRumbleStripRR > 0);
  const dt = eventDurations(telemetry);

  const flags: boolean[] = new Array(telemetry.length).fill(false);
  for (let i = 1; i < telemetry.length; i++) {
    const p = telemetry[i];
    if (dt[i - 1] <= 0 || dt[i] <= 0 || p.Speed * 2.23694 < 30) continue;
    const prev = telemetry[i - 1];
    const travelRate = Math.max(
      Math.abs(p.NormSuspensionTravelFL - prev.NormSuspensionTravelFL),
      Math.abs(p.NormSuspensionTravelFR - prev.NormSuspensionTravelFR),
      Math.abs(p.NormSuspensionTravelRL - prev.NormSuspensionTravelRL),
      Math.abs(p.NormSuspensionTravelRR - prev.NormSuspensionTravelRR),
    ) / dt[i - 1];
    if (hasRumble) {
      const onKerb = p.WheelOnRumbleStripFL > 0 || p.WheelOnRumbleStripFR > 0 || p.WheelOnRumbleStripRL > 0 || p.WheelOnRumbleStripRR > 0;
      flags[i] = onKerb && travelRate > 6; // normalized travel/s
    } else {
      flags[i] = travelRate > 10.8; // spike-only needs a stronger signal
    }
  }
  const events = groupEvents(flags, dt, 2 / 60, 20 / 60);
  if (events.length < 3) return null; // occasional kerb use is normal
  return {
    id: "driving-kerb-riding",
    category: "driving",
    severity: events.length >= 8 ? "warning" : "info",
    label: "Hard Kerb Strikes",
    detail: `${events.length} heavy kerb strikes — big compression spikes unsettle the car and can cost time or damage`,
    frameIndices: midFrame(events),
  };
}
