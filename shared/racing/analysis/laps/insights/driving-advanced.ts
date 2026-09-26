import type { TelemetryPacket } from "../../../../telemetry/types";
import type { LapPathPoint } from "../../../tracks/path";
import { reportableLoss, accelDeficitLoss, sumLosses } from "../time-loss";
import { steerBalance, steerBalanceFromSignals, type SteerBalance } from "../physics/vehicle";
import { appendInsights, INSIGHT_ORDER, insightAt, type LapInsight, type OrderedInsight } from "./types";
import { EventRun, midFrame, type RacingLineReference, type TimeLossCtx } from "./types";

import type { AccelReference } from "../time-loss";
import { runSelectedInsightScan, type InsightAccumulator } from "./scan";

export interface AdvancedDrivingScanOptions {
  ctx?: TimeLossCtx;
  physicalSlipAngles?: boolean;
  racingLine?: RacingLineReference;
}


export function createAdvancedDrivingScan(
  telemetry: readonly TelemetryPacket[],
  options: AdvancedDrivingScanOptions = {},
): InsightAccumulator {
  const drag = new EventRun(0.25);
  const under = new EventRun(10 / 60, 20 / 60);
  const over = new EventRun(10 / 60, 20 / 60);
  const sawing = new EventRun(10 / 60, 0.5);
  const kerbWithRumble = new EventRun(2 / 60, 20 / 60);
  const kerbWithoutRumble = new EventRun(2 / 60, 20 / 60);
  const downshifts: number[] = [];
  const pendingDownshifts: { start: number; elapsed: number; shiftTime: number }[] = [];
  const reversalTimes: number[] = [];
  let reversalHead = 0;
  let lastSteeringDirection = 0;
  let previous = telemetry[0];
  let shiftElapsed = 0;
  let lastShiftElapsed = Number.NEGATIVE_INFINITY;
  let maxRpm = 0;
  let hasRumble = false;
  const durationHistory: number[] = [];
  let hasWheelEvidence = !!options.ctx?.wheelStates;
  const liftCandidates: { start: number; onset: number; onsetAccel: number; lookahead: number; spin: boolean }[] = [];
  const liftRecoveries: { start: number; onset: number; recovered: number; postSeconds: number; spin: boolean }[] = [];
  let skipLiftUntil = -1;
  const liftFrames: number[] = [];
  const liftWindows: [number, number][] = [];
  const rearSpinEvidence: boolean[] = [];
  const nearRearSpin = (index: number): boolean => {
    let nearby = 0;
    for (let frame = index; frame >= 0 && nearby <= 10 / 60 + 1e-9; frame--) {
      if (!(durationHistory[frame] > 0)) break;
      if (rearSpinEvidence[frame]) return true;
      nearby += durationHistory[frame];
    }
    return false;
  };
  const racingLine = options.racingLine?.source === "track-data" && options.racingLine.points.length >= 20
    ? options.racingLine.points : undefined;
  const noProjection: { direction: number; segment: number; offset?: number } = { direction: 0, segment: -1 };
  let previousLineSegment = -1;
  const brakeZones = new EventRun(5 / 60, 10 / 60);
  type CornerSummary = {
    start: number; direction: number; candidates: number; geometrySeconds: number; minimumOutside: number;
    geometricOverlap: number; geometricLongest: number; geometricPeak: number;
    fallbackOverlap: number; fallbackLongest: number; fallbackPeak: number;
  };
  const lateEvents: [number, number][] = [];
  let geometricEvents = 0;
  let zoneStart = -1;
  let corner: CornerSummary | undefined;
  let corners: CornerSummary[] = [];
  const makeCorner = (start: number, direction: number): CornerSummary => ({
    start, direction, candidates: 0, geometrySeconds: 0, minimumOutside: Number.POSITIVE_INFINITY,
    geometricOverlap: 0, geometricLongest: 0, geometricPeak: start,
    fallbackOverlap: 0, fallbackLongest: 0, fallbackPeak: start,
  });
  const finishCorner = () => {
    if (corner) corners.push(corner);
    corner = undefined;
  };
  const finishZone = () => {
    finishCorner();
    for (const summary of corners) {
      const useGeometry = summary.geometrySeconds + 1e-9 >= 10 / 60 &&
        summary.geometrySeconds >= summary.candidates * 0.5;
      const longest = useGeometry ? summary.geometricLongest : summary.fallbackLongest;
      if (longest + 1e-9 < 10 / 60) continue;
      lateEvents.push([summary.start, useGeometry ? summary.geometricPeak : summary.fallbackPeak]);
      if (useGeometry) geometricEvents++;
    }
    corners = [];
    zoneStart = -1;
    zoneGap = 0;
  };
  let zoneGap = 0;
  const recordLift = (state: { start: number; onset: number; recovered: number; postSeconds: number; spin: boolean }) => {
    if (!state.spin) return;
    liftFrames.push(state.start);
    liftWindows.push([state.onset, state.recovered]);
  };
  return {
    observe(index, seconds, previousSeconds, wheelState) {
      const packet = telemetry[index];
      durationHistory[index] = seconds;
      const rearSpin = !!wheelState && (wheelState.rl.state === "spin" || wheelState.rr.state === "spin");
      rearSpinEvidence[index] = rearSpin;
      hasWheelEvidence ||= !!wheelState;
      for (let pending = liftRecoveries.length - 1; pending >= 0; pending--) {
        const recovery = liftRecoveries[pending];
        if (seconds <= 0 || recovery.postSeconds + seconds > 10 / 60 + 1e-9) {
          recordLift(recovery);
          liftRecoveries.splice(pending, 1);
        } else {
          recovery.spin ||= rearSpin;
          recovery.postSeconds += seconds;
          if (recovery.postSeconds + 1e-9 >= 10 / 60) {
            recordLift(recovery);
            liftRecoveries.splice(pending, 1);
          }
        }
      }
      let recoveredCandidate: (typeof liftCandidates)[number] | undefined;
      for (let pending = liftCandidates.length - 1; pending >= 0; pending--) {
        const state = liftCandidates[pending];
        state.spin ||= rearSpin;
        if (seconds <= 0 || packet.Brake > 25 || state.lookahead > 20 / 60 + 1e-9) {
          liftCandidates.splice(pending, 1);
        } else if (packet.Accel >= state.onsetAccel - 30) {
          if (!recoveredCandidate || state.start < recoveredCandidate.start) recoveredCandidate = state;
          liftCandidates.splice(pending, 1);
        } else {
          state.lookahead += seconds;
        }
      }
      if (recoveredCandidate) {
        liftCandidates.length = 0;
        skipLiftUntil = index;
        liftRecoveries.push({
          start: recoveredCandidate.start,
          onset: recoveredCandidate.onset,
          recovered: index,
          postSeconds: seconds,
          spin: recoveredCandidate.spin || rearSpin,
        });
      }
      if (hasWheelEvidence && !recoveredCandidate && index > skipLiftUntil &&
        index > 0 && seconds > 0 && packet.Brake <= 25) {
        let onset = -1;
        let lookback = 0;
        for (let frame = index - 1; frame >= 0; frame--) {
          const before = telemetry[frame];
          const beforeSeconds = durationHistory[frame];
          if (beforeSeconds <= 0 || before.Brake > 25) break;
          lookback += beforeSeconds;
          if (lookback > 0.1 + 1e-9) break;
          if (before.Accel > 180 && before.Accel - packet.Accel >= 60) {
            onset = frame;
            break;
          }
        }
        if (onset >= 0) {
          liftCandidates.push({ start: index, onset, onsetAccel: telemetry[onset].Accel, lookahead: seconds, spin: nearRearSpin(index) });
        }
      }
      if (index === 0) maxRpm = packet.EngineMaxRpm;
      const throttle = packet.Accel / 255;
      const brake = packet.Brake / 255;
      drag.feed(index, seconds, throttle > 0.5 && brake > 0.005 && brake < 0.25);

      if (index > 0 && previousSeconds <= 0) lastSteeringDirection = 0;
      if (index > 0 && previousSeconds > 0 && seconds > 0 && Math.abs(packet.Steer) >= 15 && packet.Speed * 2.23694 >= 40) {
        const derivative = (packet.Steer - previous.Steer) / previousSeconds;
        if (Math.abs(derivative) >= 300) {
          const direction = Math.sign(derivative);
          if (lastSteeringDirection !== 0 && direction !== lastSteeringDirection) reversalTimes.push(packet.TimestampMS);
          lastSteeringDirection = direction;
        }
      } else {
        lastSteeringDirection = 0;
        reversalTimes.length = 0;
        reversalHead = 0;
      }
      while (reversalHead < reversalTimes.length && packet.TimestampMS - reversalTimes[reversalHead] >= 1000) reversalHead++;
      if (reversalHead >= 64) {
        reversalTimes.splice(0, reversalHead);
        reversalHead = 0;
      }
      const validSawing = seconds > 0 && previousSeconds > 0 && Math.abs(packet.Steer) >= 15 && packet.Speed * 2.23694 >= 40;
      sawing.feed(index, seconds, validSawing && reversalTimes.length - reversalHead >= 4);

      if (previousSeconds <= 0) previousLineSegment = -1;
      const projected = racingLine
        ? projectRacingLinePacket(packet, racingLine, previousLineSegment)
        : noProjection;
      previousLineSegment = projected.segment;
      const cornering = packet.Speed * 2.23694 >= 30 && Math.abs(packet.Steer) >= 15;
      const balance = cornering ? balanceForPacket(packet, options.physicalSlipAngles ?? true) : undefined;
      under.feed(index, seconds, cornering && Math.abs(packet.Steer) >= 25 &&
        balance?.state === "understeer" && balance.severity > 0.4);
      over.feed(index, seconds, cornering &&
        balance?.state === "oversteer" && balance.severity > 0.4);
      const brakeFlag = packet.Brake > 25;
      if (brakeFlag) zoneGap = 0;
      else if (seconds > 0) zoneGap += seconds;
      const closesZone = seconds <= 0 || (!brakeFlag && zoneGap > 10 / 60 + 1e-9);
      const zoneEventCount = brakeZones.events.length;
      brakeZones.feed(index, seconds, brakeFlag);
      if (brakeZones.events.length > zoneEventCount) {
        finishZone();
      } else if (closesZone) {
        finishZone();
      } else {
        if (brakeFlag && seconds > 0 && zoneStart < 0) {
          zoneStart = index;
          corners = [];
          corner = makeCorner(index, 0);
        }
        if (zoneStart >= 0 && seconds > 0) {
          const direction = projected.direction;
          if (direction !== 0 && corner && corner.direction !== 0 && corner.direction !== direction) {
            finishCorner();
            corner = makeCorner(index, direction);
          } else if (direction !== 0 && corner && corner.direction === 0) {
            corner.direction = direction;
          }
          if (!corner) corner = makeCorner(zoneStart, direction);
          if (packet.Brake > 90 && Math.abs(packet.Steer) > 35 && packet.Speed * 2.23694 > 30) {
            corner.candidates += seconds;
            if (projected.offset !== undefined) corner.geometrySeconds += seconds;
          }
          if (projected.offset === undefined) corner.minimumOutside = Number.POSITIVE_INFINITY;
          else corner.minimumOutside = Math.min(corner.minimumOutside, projected.offset);
          const candidate = packet.Brake > 90 && Math.abs(packet.Steer) > 35 && packet.Speed * 2.23694 > 30;
          const geometricOverlap = seconds > 0 && candidate && projected.offset !== undefined &&
            projected.offset > RACING_LINE_OUTSIDE_M &&
            projected.offset - corner.minimumOutside > RACING_LINE_GROWTH_M;
          if (geometricOverlap) {
            corner.geometricOverlap += seconds;
            if (corner.geometricOverlap > corner.geometricLongest) {
              corner.geometricLongest = corner.geometricOverlap;
              corner.geometricPeak = index;
            }
          } else corner.geometricOverlap = 0;
          const fallbackOverlap = seconds > 0 && candidate && projected.offset === undefined &&
            balance?.state === "understeer" && balance.severity > 0.3;
          if (fallbackOverlap) {
            corner.fallbackOverlap += seconds;
            if (corner.fallbackOverlap > corner.fallbackLongest) {
              corner.fallbackLongest = corner.fallbackOverlap;
              corner.fallbackPeak = index;
            }
          } else corner.fallbackOverlap = 0;
        }
      }

      hasRumble ||= packet.WheelOnRumbleStripFL > 0 || packet.WheelOnRumbleStripFR > 0 ||
        packet.WheelOnRumbleStripRL > 0 || packet.WheelOnRumbleStripRR > 0;
      let travelRate = 0;
      if (index > 0 && previousSeconds > 0 && seconds > 0 && packet.Speed * 2.23694 >= 30) {
        travelRate = Math.max(
          Math.abs(packet.NormSuspensionTravelFL - previous.NormSuspensionTravelFL),
          Math.abs(packet.NormSuspensionTravelFR - previous.NormSuspensionTravelFR),
          Math.abs(packet.NormSuspensionTravelRL - previous.NormSuspensionTravelRL),
          Math.abs(packet.NormSuspensionTravelRR - previous.NormSuspensionTravelRR),
        ) / previousSeconds;
      }
      const onKerb = packet.WheelOnRumbleStripFL > 0 || packet.WheelOnRumbleStripFR > 0 ||
        packet.WheelOnRumbleStripRL > 0 || packet.WheelOnRumbleStripRR > 0;
      kerbWithRumble.feed(index, seconds, previousSeconds > 0 && seconds > 0 && onKerb && travelRate > 6);
      kerbWithoutRumble.feed(index, seconds, previousSeconds > 0 && seconds > 0 && travelRate > 10.8);

      if (index > 0) {
        if (previousSeconds <= 0) {
          lastShiftElapsed = Number.NEGATIVE_INFINITY;
          pendingDownshifts.length = 0;
        } else {
          shiftElapsed += previousSeconds;
          if (packet.Gear > 0 && previous.Gear > packet.Gear &&
            shiftElapsed - lastShiftElapsed + 1e-9 >= 1) {
            pendingDownshifts.push({ start: index, elapsed: 0, shiftTime: shiftElapsed });
          }
        }
      }
      for (let pending = 0; pending < pendingDownshifts.length;) {
        const state = pendingDownshifts[pending];
        if (seconds <= 0 || state.shiftTime - lastShiftElapsed + 1e-9 < 1) {
          pendingDownshifts.splice(pending, 1);
        } else if (maxRpm > 0 && packet.CurrentEngineRpm >= maxRpm * 0.97) {
          downshifts.push(index);
          lastShiftElapsed = state.shiftTime;
          pendingDownshifts.splice(pending, 1);
        } else {
          state.elapsed += seconds;
          if (state.elapsed >= 0.3 - 1e-9) pendingDownshifts.splice(pending, 1);
          else pending++;
        }
      }
      previous = packet;
    },
    finish(ref?: AccelReference) {
      drag.finish();
      under.finish();
      over.finish();
      sawing.finish();
      kerbWithRumble.finish();
      kerbWithoutRumble.finish();
      const completedBrakeZones = brakeZones.events.length;
      brakeZones.finish();
      if (brakeZones.events.length > completedBrakeZones) finishZone();
      else if (zoneStart >= 0) finishZone();
      for (const recovery of liftRecoveries) recordLift(recovery);
      const lossRef = options.ctx?.ref ?? ref;
      const lossDt = options.ctx?.dt;
      const microLiftLoss = lossRef && lossDt
        ? reportableLoss(sumLosses(liftWindows.map(([start, end]) =>
          accelDeficitLoss(telemetry as TelemetryPacket[], lossDt, start, end, lossRef))))
        : undefined;
      const makeEvent = (id: string, label: string, severity: "info" | "warning" | "critical", detail: string, events: [number, number][], frames?: number[]): LapInsight | null =>
        events.length ? { id, category: "driving", severity, label, detail, frameIndices: frames ?? midFrame(events) } : null;
      const dragEvents = drag.events;
      const dragTotal = drag.acceptedSeconds;
      const underEvents = under.events;
      const overEvents = over.events;
      const sawingEvents = sawing.events;
      const kerbEvents = hasRumble ? kerbWithRumble.events : kerbWithoutRumble.events;
      const results: OrderedInsight[] = [];
      appendInsights(results, INSIGHT_ORDER.brakeDrag, makeEvent("driving-brake-drag", "Brake Drag",
        dragTotal > 3 ? "critical" : dragTotal > 1 ? "warning" : "info",
        `Brake applied while on full throttle ${dragEvents.length} time${dragEvents.length > 1 ? "s" : ""} (${dragTotal.toFixed(1)}s total). Check foot position — resting on the brake pedal costs straight-line speed.`,
        dragEvents));
      appendInsights(results, INSIGHT_ORDER.downshiftOverRev, downshifts.length ? {
        id: "driving-downshift-over-rev", category: "driving",
        severity: downshifts.length >= 4 ? "warning" : "info",
        label: "Aggressive Downshifts",
        detail: `${downshifts.length} downshift${downshifts.length > 1 ? "s" : ""} spiked RPM near the limiter — shift down later to avoid engine-braking lockups`,
        frameIndices: downshifts,
      } : null);
      appendInsights(results, INSIGHT_ORDER.lateBrakingOvershoot, lateEvents.length ? {
        id: "driving-late-braking-overshoot", category: "driving",
        severity: lateEvents.length >= 3 ? "warning" : "info",
        label: "Late Braking Overshoot",
        detail: `${lateEvents.length} corner${lateEvents.length > 1 ? "s" : ""} — ${geometricEvents === lateEvents.length
          ? "braking carried the car progressively outside the reference racing line"
          : geometricEvents === 0
            ? "still braking hard with heavy steering and front scrub"
            : `${geometricEvents} departed the reference racing line; the others combined hard braking, heavy steering and front scrub where geometry was unavailable`}. Brake earlier or release sooner to rotate.`,
        frameIndices: lateEvents.map(([, peak]) => peak),
      } : null);
      appendInsights(results, INSIGHT_ORDER.understeerScrub, makeEvent("driving-understeer-scrub", "Understeer Scrub",
        underEvents.length >= 4 || under.acceptedSeconds > 3 ? "warning" : "info",
        `${underEvents.length} corner${underEvents.length > 1 ? "s" : ""} with sustained front scrub (${under.acceptedSeconds.toFixed(1)}s total) — slow entry slightly or open the steering to regain front grip`,
        underEvents));
      appendInsights(results, INSIGHT_ORDER.oversteerSlide, makeEvent("driving-oversteer-slide", "Oversteer Slide",
        overEvents.length >= 4 || over.acceptedSeconds > 3 ? "warning" : "info",
        `${overEvents.length} corner${overEvents.length > 1 ? "s" : ""} with sustained rear slip — reduce entry speed or feed throttle more progressively`,
        overEvents));
      appendInsights(results, INSIGHT_ORDER.steeringSawing, makeEvent("driving-steering-sawing", "Steering Sawing",
        sawingEvents.length >= 3 ? "warning" : "info",
        `${sawingEvents.length} zone${sawingEvents.length > 1 ? "s" : ""} of rapid steering corrections — smooth the inputs; sawing scrubs speed and unsettles the car`,
        sawingEvents));
      appendInsights(results, INSIGHT_ORDER.throttleMicroLifts, liftFrames.length >= 4 ? {
        id: "driving-throttle-micro-lifts", category: "driving",
        severity: liftFrames.length >= 8 ? "warning" : "info",
        label: "Throttle Micro-Lifts",
        detail: `${liftFrames.length} quick lifts under power with rear slip — feeding throttle more progressively beats stabbing and lifting`,
        frameIndices: liftFrames,
        timeLossS: microLiftLoss,
      } : null);
      appendInsights(results, INSIGHT_ORDER.kerbRiding, makeEvent("driving-kerb-riding", "Hard Kerb Strikes",
        kerbEvents.length >= 8 ? "warning" : "info",
        `${kerbEvents.length} heavy kerb strikes — big compression spikes unsettle the car and can cost time or damage`,
        kerbEvents.length >= 3 ? kerbEvents : []));
      return results;
    },
  };
}

export function detectBrakeDrag(telemetry: TelemetryPacket[]): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createAdvancedDrivingScan(telemetry)), INSIGHT_ORDER.brakeDrag);
}

function balanceForPacket(packet: TelemetryPacket, physicalSlipAngles: boolean): SteerBalance {
  if (physicalSlipAngles) return steerBalance(packet);
  return steerBalanceFromSignals({
    speedMps: packet.Speed,
    accelerationX: packet.AccelerationX,
    yawRate: packet.AngularVelocityY,
  });
}

const RACING_LINE_OUTSIDE_M = 1.5;
const RACING_LINE_GROWTH_M = 1;
const RACING_LINE_MAX_PROJECTION_M = 12;
function projectRacingLinePacket(
  packet: TelemetryPacket,
  racingLine: readonly LapPathPoint[],
  previousSegment: number,
): { offset?: number; direction: number; segment: number } {
  const segmentCount = racingLine.length;
  const px = packet.PositionX;
  const pz = packet.PositionZ;
  if (segmentCount < 20 || !Number.isFinite(px) || !Number.isFinite(pz) || (px === 0 && pz === 0)) {
    return { direction: 0, segment: previousSegment };
  }
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
  if (bestSegment < 0 || bestDistanceSquared > RACING_LINE_MAX_PROJECTION_M ** 2) {
    return { direction: 0, segment: previousSegment };
  }
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
  if (!(incomingLength > 0) || !(outgoingLength > 0)) return { direction: 0, segment: bestSegment };
  const curvature = (incomingX * outgoingZ - incomingZ * outgoingX) / (incomingLength * outgoingLength);
  if (Math.abs(curvature) < 0.015) return { direction: 0, segment: bestSegment };
  const tangentX = end.x - start.x;
  const tangentZ = end.z - start.z;
  const tangentLength = Math.hypot(tangentX, tangentZ);
  if (!(tangentLength > 0)) return { direction: 0, segment: bestSegment };
  const signedLateral = (tangentX * (pz - bestProjectionZ) - tangentZ * (px - bestProjectionX)) / tangentLength;
  return { offset: -Math.sign(curvature) * signedLateral, direction: Math.sign(curvature), segment: bestSegment };
}

export function detectDownshiftOverRev(telemetry: TelemetryPacket[]): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createAdvancedDrivingScan(telemetry)), INSIGHT_ORDER.downshiftOverRev);
}

export function detectLateBrakingOvershoot(telemetry: TelemetryPacket[], physicalSlipAngles = true, racingLine?: RacingLineReference): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createAdvancedDrivingScan(telemetry, { physicalSlipAngles, racingLine })), INSIGHT_ORDER.lateBrakingOvershoot);
}

export function detectUndersteerScrub(telemetry: TelemetryPacket[], physicalSlipAngles = true): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createAdvancedDrivingScan(telemetry, { physicalSlipAngles })), INSIGHT_ORDER.understeerScrub);
}

export function detectOversteerSlide(telemetry: TelemetryPacket[], physicalSlipAngles = true): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createAdvancedDrivingScan(telemetry, { physicalSlipAngles })), INSIGHT_ORDER.oversteerSlide);
}

export function detectSteeringSawing(telemetry: TelemetryPacket[]): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createAdvancedDrivingScan(telemetry)), INSIGHT_ORDER.steeringSawing);
}

export function detectThrottleMicroLifts(telemetry: TelemetryPacket[], ctx?: TimeLossCtx): LapInsight | null {
  const state = createAdvancedDrivingScan(telemetry, { ctx });
  return insightAt(runSelectedInsightScan(telemetry, state, {
    durations: ctx?.dt,
    wheelStates: ctx?.wheelStates,
    ref: ctx?.ref,
  }), INSIGHT_ORDER.throttleMicroLifts);
}

export function detectKerbRiding(telemetry: TelemetryPacket[]): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createAdvancedDrivingScan(telemetry)), INSIGHT_ORDER.kerbRiding);
}
