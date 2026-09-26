import type { TelemetryPacket } from "../../../../telemetry/types";
import { reportableLoss, accelDeficitLoss, speedDeficitLoss, sumLosses } from "../time-loss";
import type { AllWheelStates } from "../physics/vehicle";
import { appendInsights, INSIGHT_ORDER, insightAt, type LapInsight, type OrderedInsight, eventDurations, midFrame, EventRun, type TimeLossCtx } from "./types";
import { runSelectedInsightScan, type InsightAccumulator } from "./scan";

function mergeThrottleEvents(
  events: [number, number][],
  telemetry: readonly TelemetryPacket[],
  maxGapSeconds: number,
): [number, number][] {
  events.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const event of events) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push([...event]);
      continue;
    }
    let gap = 0;
    let continuous = true;
    for (let i = last[1]; i < event[0]; i++) {
      const seconds = (telemetry[i + 1].TimestampMS - telemetry[i].TimestampMS) / 1000;
      if (!(seconds > 0 && seconds <= 0.1)) {
        continuous = false;
        break;
      }
      if (i > last[1]) gap += seconds;
    }
    if (continuous && gap <= maxGapSeconds + 1e-9) last[1] = Math.max(last[1], event[1]);
    else merged.push([...event]);
  }
  return merged;
}

export function createCoreDrivingScan(
  telemetry: readonly TelemetryPacket[],
  ctx?: TimeLossCtx,
  wheelStates?: readonly AllWheelStates[],
): InsightAccumulator {
  const limiter = new EventRun(10 / 60, 20 / 60);
  const coasting = new EventRun(0.5);
  const coastBrakeEligible: boolean[] = [];
  const coastLookahead: { event: number; end: number; elapsed: number }[] = [];
  const brakeTrail = new EventRun(3 / 60);
  const brakeAfter = new EventRun(3 / 60, 10 / 60);
  const brakeSlow = new EventRun(5 / 60, 10 / 60);
  const earlyPower = new EventRun(0.1, 0.15);
  const turns = new EventRun(0.25, 0.1);
  const delayedEvents: [number, number][] = [];
  let turnStart = -1;
  let turnDirection = 0;
  let turnValid = true;
  let turnPeakSteer = 0;
  let turnApexSpeed = Number.POSITIVE_INFINITY;
  let exit: { direction: number; peakSteer: number; apexSpeed: number; elapsed: number; stableStart: number; stableEnd: number; stableSeconds: number } | undefined;
  let exitLookahead: { start: number; end: number; elapsed: number; direction: number } | undefined;
  const earlyEvents: [number, number][] = [];
  const overSlowEvents: [number, number][] = [];
  const earlyPending: { end: number; elapsed: number; coastSeconds: number }[] = [];
  const durationAt = (i: number): number => {
    if (i + 1 >= telemetry.length) return 0;
    const delta = (telemetry[i + 1].TimestampMS - telemetry[i].TimestampMS) / 1000;
    return Number.isFinite(delta) && delta > 0 && delta <= 0.1 ? delta : 0;
  };
  const earlyCorrectionEvents: [number, number][] = [];
  const binaryCorrectionEvents: [number, number][] = [];
  let reversal: { start: number; end: number; direction: number; lowSeconds: number; high: number; highSteer: boolean } | undefined;
  let maxRpm = 0;
  let totalSeconds = 0;
  let trailZoneStart = -1;
  let trailTurned = false;
  let acceptedTrailCount = 0;

  return {
    observe(index, seconds, _previousSeconds, wheelState) {
      const packet = telemetry[index];
      if (index === 0) maxRpm = packet.EngineMaxRpm;
      totalSeconds += seconds > 0 ? seconds : 0;
      limiter.feed(index, seconds, maxRpm > 0 && packet.CurrentEngineRpm >= maxRpm - 50);
      const coastFlag = packet.Accel < 5 && packet.Brake < 5 && packet.Speed * 2.23694 > 20;
      const coastCount = coasting.events.length;
      coasting.feed(index, seconds, coastFlag);
      if (coasting.events.length > coastCount) {
        const event = coasting.events.length - 1;
        coastBrakeEligible[event] = true;
        coastLookahead.push({ event, end: coasting.events[event][1], elapsed: 0 });
      }
      for (let pending = coastLookahead.length - 1; pending >= 0; pending--) {
        const state = coastLookahead[pending];
        if (index <= state.end) continue;
        if (_previousSeconds <= 0 || seconds <= 0 || packet.Brake > 25) {
          coastBrakeEligible[state.event] = false;
          coastLookahead.splice(pending, 1);
        } else {
          state.elapsed += seconds;
          if (state.elapsed >= 0.5) coastLookahead.splice(pending, 1);
        }
      }

      const braking = packet.Brake > 25;
      const earlyCount = brakeAfter.events.length;
      const slowCount = brakeSlow.events.length;
      brakeAfter.feed(index, seconds, braking);
      brakeSlow.feed(index, seconds, braking);
      if (brakeAfter.events.length > earlyCount) {
        const end = brakeAfter.events[brakeAfter.events.length - 1][1];
        const state = { end, elapsed: 0, coastSeconds: 0 };
        let closed = false;
        for (let j = end + 1; j < index; j++) {
          const delta = (telemetry[j + 1].TimestampMS - telemetry[j].TimestampMS) / 1000;
          const prior = (telemetry[j].TimestampMS - telemetry[j - 1].TimestampMS) / 1000;
          if (!(delta > 0 && delta <= 0.1 && prior > 0 && prior <= 0.1) || telemetry[j].Brake > 25 || state.elapsed >= 1.5) { closed = true; break; }
          state.elapsed += delta;
          if (telemetry[j].Accel < 50) state.coastSeconds += delta;
          else if (telemetry[j].Accel > 140 && Math.abs(telemetry[j].Steer) > 25) {
            if (state.coastSeconds >= 0.25) earlyEvents.push([end, j]);
            closed = true; break;
          }
        }
        if (!closed) earlyPending.push(state);
      }
      if (brakeSlow.events.length > slowCount) {
        const brakeEnd = brakeSlow.events[brakeSlow.events.length - 1][1];
        const releaseSpeed = telemetry[brakeEnd].Speed;
        if (releaseSpeed * 2.23694 >= 25) {
          let minIdx = brakeEnd, minSpeed = releaseSpeed;
          for (let j = brakeEnd + 1, elapsed = 0; j < telemetry.length && elapsed < 2; j++) {
            if (durationAt(j - 1) <= 0 || durationAt(j) <= 0 || telemetry[j].Brake > 25) break;
            elapsed += durationAt(j);
            if (telemetry[j].Speed < minSpeed) { minSpeed = telemetry[j].Speed; minIdx = j; }
          }
          if ((releaseSpeed - minSpeed) / releaseSpeed >= 0.08) {
            for (let j = minIdx, elapsed = 0; j < telemetry.length && elapsed < 1; j++) {
              if (durationAt(j) <= 0 || (j > minIdx && durationAt(j - 1) <= 0)) break;
              elapsed += durationAt(j);
              if (telemetry[j].Brake > 25) break;
              if (telemetry[j].Accel > 80 && Math.abs(telemetry[j].Steer) > 25) {
                overSlowEvents.push([brakeEnd, minIdx]); break;
              }
            }
          }
        }
      }
      for (let pending = earlyPending.length - 1; pending >= 0; pending--) {
        const state = earlyPending[pending];
        if (index <= state.end) continue;
        if (_previousSeconds <= 0 || seconds <= 0 || packet.Brake > 25 || state.elapsed >= 1.5) {
          earlyPending.splice(pending, 1);
        } else {
          state.elapsed += seconds;
          if (packet.Accel < 50) state.coastSeconds += seconds;
          else if (packet.Accel > 140 && Math.abs(packet.Steer) > 25) {
            if (state.coastSeconds >= 0.25) earlyEvents.push([state.end, index]);
            earlyPending.splice(pending, 1);
          }
        }
      }
      // Corner-speed lookahead is bounded to two seconds plus one from its apex.
      const brakeFlag = packet.Brake > 10;
      if (brakeFlag && trailZoneStart < 0) {
        trailZoneStart = index;
        trailTurned = false;
      }
      if (brakeFlag && Math.abs(packet.Steer) > 15) trailTurned = true;
      const countBefore = brakeTrail.events.length;
      brakeTrail.feed(index, seconds, brakeFlag);
      if (brakeTrail.events.length > countBefore) {
        if (trailTurned) acceptedTrailCount++;
        trailZoneStart = -1;
        trailTurned = false;
      }
      if (!brakeFlag || seconds <= 0) {
        trailZoneStart = -1;
        trailTurned = false;
      }

      const slipping = wheelSlipping(wheelState ?? wheelStates?.[index]);
      const rotating = Number.isFinite(packet.AccelerationX) &&
        Math.abs(packet.AngularVelocityY) > Math.abs(packet.AccelerationX) / packet.Speed + 0.3;
      earlyPower.feed(index, seconds,
        activeExit(packet) && packet.Accel > 100 && Math.abs(packet.Steer) > 40 && (slipping || rotating));
      const previous = telemetry[index - 1];
      if (reversal) {
        if (seconds <= 0 || !activeExit(packet) || packet.Accel >= 25 ||
          Math.sign(packet.Steer) !== reversal.direction || Math.abs(packet.Steer) < 20) {
          reversal = undefined;
        } else {
          reversal.lowSeconds += seconds;
          if (reversal.lowSeconds >= 0.1) {
            if (reversal.highSteer) earlyCorrectionEvents.push([reversal.start, reversal.end]);
            if (reversal.high >= 230) binaryCorrectionEvents.push([reversal.start, reversal.end]);
            reversal = undefined;
          }
        }
      }
      if (!reversal && previous && previous.Accel >= 25 && packet.Accel < 25) {
        const direction = Math.sign(packet.Steer);
        let highStart = -1, highEnd = -1, highSeconds = 0, elapsed = 0, sawLow = false;
        let highFloor = Number.POSITIVE_INFINITY, highSteer = false;
        for (let j = index - 1; j >= 0 && elapsed < 1; j--) {
          const q = telemetry[j];
          const d = (telemetry[j + 1].TimestampMS - q.TimestampMS) / 1000;
          if (!(d > 0 && d <= 0.1) || !activeExit(q) || Math.sign(q.Steer) !== direction ||
            Math.abs(q.Steer) < 25 || !(Math.abs(q.AngularVelocityY) > 0.15 || Math.abs(q.AccelerationX) > 2)) break;
          elapsed += d;
          if (q.Accel >= 100) {
            if (highEnd < 0 && elapsed > 0.25) break;
            highStart = j;
            if (highEnd < 0) highEnd = j;
            highSeconds += d;
            highFloor = Math.min(highFloor, q.Accel);
            highSteer ||= Math.abs(q.Steer) > 40;
          } else if (highStart >= 0 && q.Accel < 25) {
            sawLow = true;
            break;
          }
        }
        if (sawLow && highSeconds >= 0.1 && activeExit(packet) && Math.abs(packet.Steer) >= 20) {
          reversal = { start: highStart, end: highEnd, direction, lowSeconds: seconds, high: highFloor, highSteer };
        }
      }
      const turnFlag = activeExit(packet) && Math.abs(packet.Steer) >= 30;
      if (exit && activeExit(packet) && Math.abs(packet.Steer) >= 30) exit = undefined;
      const priorTurnCount = turns.events.length;
      if (turnFlag) {
        if (turnStart < 0) {
          turnStart = index;
          turnDirection = Math.sign(packet.Steer);
          turnPeakSteer = 0;
          turnApexSpeed = Number.POSITIVE_INFINITY;
          turnValid = true;
        }
        if (Math.sign(packet.Steer) !== turnDirection) turnValid = false;
        turnPeakSteer = Math.max(turnPeakSteer, Math.abs(packet.Steer));
        turnApexSpeed = Math.min(turnApexSpeed, packet.Speed);
      }
      turns.feed(index, seconds, turnFlag);
      if (turns.events.length > priorTurnCount) {
        if (turnValid) exit = {
          direction: turnDirection,
          peakSteer: turnPeakSteer,
          apexSpeed: turnApexSpeed,
          elapsed: 0,
          stableStart: -1,
          stableEnd: -1,
          stableSeconds: 0,
        };
        turnStart = -1;
      }
      if (exitLookahead) {
        if (seconds <= 0 || !activeExit(packet) || Math.abs(packet.Steer) > 25 ||
          (Math.abs(packet.Steer) > 10 && Math.sign(packet.Steer) !== exitLookahead.direction)) {
          exitLookahead = undefined;
        } else {
          exitLookahead.elapsed += seconds;
          if (exitLookahead.elapsed >= 0.5) {
            delayedEvents.push([exitLookahead.start, exitLookahead.end]);
            exitLookahead = undefined;
          }
        }
      }
      if (exit && !turnFlag) {
        const state = exit;
        const previous = telemetry[index - 1];
        if (seconds <= 0 || !activeExit(packet) ||
          (Math.abs(packet.Steer) > 10 && Math.sign(packet.Steer) !== state.direction) ||
          Math.abs(packet.Steer) > Math.abs(previous?.Steer ?? packet.Steer) + 5) {
          exit = undefined;
        } else {
          state.elapsed += seconds;
          const wheel = wheelState ?? wheelStates?.[index];
          const stableGrip = !wheel || (wheel.fl.state === "grip" && wheel.fr.state === "grip" &&
            wheel.rl.state === "grip" && wheel.rr.state === "grip");
          const unloaded = Number.isFinite(packet.AccelerationX) && Number.isFinite(packet.AngularVelocityY) &&
            Math.abs(packet.AccelerationX) < 4 && Math.abs(packet.AngularVelocityY) * packet.Speed < 4 &&
            !!previous && _previousSeconds > 0 &&
            Math.abs(packet.AngularVelocityY - previous.AngularVelocityY) / _previousSeconds < 1.5;
          if (!stableGrip || !unloaded) {
            if (state.stableStart >= 0) exit = undefined;
          } else if (packet.Accel >= 80) {
            if (state.stableStart >= 0 && state.stableSeconds >= 0.6) {
              exitLookahead = { start: state.stableStart, end: state.stableEnd, elapsed: 0, direction: state.direction };
            }
            exit = undefined;
          } else if (Math.abs(packet.Steer) <= Math.min(18, state.peakSteer * 0.45) &&
            packet.Speed >= state.apexSpeed * 0.98 && packet.Accel < 50) {
            if (state.stableStart < 0) state.stableStart = index;
            state.stableEnd = index;
            state.stableSeconds += seconds;
            if (state.elapsed >= 3 && state.stableSeconds >= 0.6) {
              exitLookahead = { start: state.stableStart, end: state.stableEnd, elapsed: 0, direction: state.direction };
              exit = undefined;
            }
          } else if (state.stableStart >= 0) {
            exit = undefined;
          }
          if (state.elapsed >= 3) exit = undefined;
        }
      }
    },
    finish(ref) {
      limiter.finish();
      coasting.finish();
      const trailCountBeforeFinish = brakeTrail.events.length;
      brakeTrail.finish();
      if (brakeTrail.events.length > trailCountBeforeFinish && trailTurned) acceptedTrailCount++;
      brakeAfter.finish();
      brakeSlow.finish();
      earlyPower.finish();
      turns.finish();
      const limiterEvents = limiter.events;
      const coastEvents = coasting.events;
      const trailEvents = brakeTrail.events;
      const throttleEvents = mergeThrottleEvents([...earlyPower.events, ...earlyCorrectionEvents], telemetry, 0.15);
      const binaryEvents = mergeThrottleEvents(binaryCorrectionEvents, telemetry, 0.3);
      const reference = ctx && ref ? { ...ctx, ref } : ctx;
      const coastLosses = reference
        ? coastEvents.map(([start, end], event) => coastBrakeEligible[event] !== false
          ? speedDeficitLoss(telemetry as TelemetryPacket[], reference.dt, start, end, telemetry[start].Speed)
          : undefined) : [];
      const revLosses = reference
        ? limiterEvents.map(([start, end]) => accelDeficitLoss(telemetry as TelemetryPacket[], reference.dt, start, end, reference.ref))
        : [];
      const output: OrderedInsight[] = [];
      appendInsights(output, INSIGHT_ORDER.revLimiter, limiterEvents.length ? {
        id: "driving-rev-limiter", category: "driving",
        severity: limiterEvents.length >= 5 ? "warning" : "info",
        label: "Rev Limiter",
        detail: `Hit limiter ${limiterEvents.length} time${limiterEvents.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(limiterEvents),
        timeLossS: reference ? reportableLoss(sumLosses(revLosses)) : undefined,
      } : null);
      appendInsights(output, INSIGHT_ORDER.coasting, coastEvents.length ? {
        id: "driving-coasting", category: "driving",
        severity: coasting.acceptedSeconds > 2 ? "warning" : "info",
        label: "Coasting",
        detail: `${coastEvents.length} zone${coastEvents.length > 1 ? "s" : ""}, ${((coasting.acceptedSeconds / totalSeconds) * 100).toFixed(1)}% of lap`,
        frameIndices: midFrame(coastEvents),
        timeLossS: reference ? reportableLoss(sumLosses(coastLosses)) : undefined,
      } : null);
      appendInsights(output, INSIGHT_ORDER.trailBraking, trailEvents.length ? {
        id: "driving-trail-brake", category: "driving", severity: "info", label: "Trail Braking",
        detail: `${acceptedTrailCount}/${trailEvents.length} brake zones (${((acceptedTrailCount / trailEvents.length) * 100).toFixed(0)}%)`,
        frameIndices: midFrame(trailEvents),
      } : null);
      appendInsights(output, INSIGHT_ORDER.earlyBraking, earlyEvents.length ? {
        id: "driving-early-braking", category: "driving", severity: "info", label: "Coast After Braking",
        detail: `${earlyEvents.length} corner${earlyEvents.length > 1 ? "s" : ""} — low throttle after brake release, then power while turning. Without a comparable corner reference, this does not establish early braking or lost time.`,
        frameIndices: midFrame(earlyEvents),
      } : null);
      appendInsights(output, INSIGHT_ORDER.overSlowing, overSlowEvents.length ? {
        id: "driving-over-slowing", category: "driving", severity: "info", label: "Corner Speed Reduction",
        detail: `${overSlowEvents.length} corner${overSlowEvents.length > 1 ? "s" : ""} — speed fell after brake release before power resumed while turning. Corner geometry and grip may require this; excess slowing or lost time is not established.`,
        frameIndices: overSlowEvents.map(([, minIndex]) => minIndex),
      } : null);
      appendInsights(output, INSIGHT_ORDER.earlyThrottle, throttleEvents.length ? {
        id: "driving-early-throttle", category: "driving",
        severity: throttleEvents.length >= 5 ? "warning" : "info",
        label: "Corner Throttle Correction",
        detail: `${throttleEvents.length} zone${throttleEvents.length > 1 ? "s" : ""} — corner power coincided with wheelspin, excess rotation, or an abrupt corrective lift`,
        frameIndices: midFrame(throttleEvents),
      } : null);
      appendInsights(output, INSIGHT_ORDER.binaryThrottle, binaryEvents.length ? {
        id: "driving-binary-throttle", category: "driving",
        severity: binaryEvents.length >= 3 ? "warning" : "info",
        label: "Abrupt Corner Throttle",
        detail: `${binaryEvents.length} corner power reversal${binaryEvents.length > 1 ? "s" : ""} — near-full throttle followed by a rapid lift while still turning`,
        frameIndices: midFrame(binaryEvents),
      } : null);
      appendInsights(output, INSIGHT_ORDER.delayedThrottlePickup, delayedEvents.length ? {
        id: "driving-delayed-throttle-pickup", category: "driving", severity: "info",
        label: "Low Throttle After Unwind",
        detail: `${delayedEvents.length} exit${delayedEvents.length > 1 ? "s" : ""} — low throttle continued after steering and lateral load reduced. No matched clean-corner reference; available grip and time loss are not established.`,
        frameIndices: midFrame(delayedEvents),
      } : null);
      return output;
    },
  };
}


function activeExit(p: TelemetryPacket): boolean {
  return p.IsRaceOn !== 0 && p.Speed > 13.4 && p.Brake < 10 && !(p.Clutch > 25) &&
    !(p.HandBrake > 0) && p.Gear !== 0 &&
    !p.iracing?.onPitRoad && !(p.f1?.pitLimiterStatus) &&
    !(p.f1?.pitLaneTimerActive) && (!p.acc?.pitStatus || p.acc.pitStatus === "out");
}

function wheelSlipping(ws: AllWheelStates | undefined): boolean {
  return !!ws && (ws.fl.state === "spin" || ws.fr.state === "spin" ||
    ws.rl.state === "spin" || ws.rr.state === "spin");
}

export function detectRevLimiter(telemetry: TelemetryPacket[], ctx?: TimeLossCtx): LapInsight | null {
  const durations = ctx?.dt ?? eventDurations(telemetry);
  return insightAt(runSelectedInsightScan(telemetry, createCoreDrivingScan(telemetry, ctx), { durations, wheelStates: ctx?.wheelStates, ref: ctx?.ref }), INSIGHT_ORDER.revLimiter);
}

export function detectCoasting(telemetry: TelemetryPacket[], ctx?: TimeLossCtx): LapInsight | null {
  const durations = ctx?.dt ?? eventDurations(telemetry);
  return insightAt(runSelectedInsightScan(telemetry, createCoreDrivingScan(telemetry, ctx), { durations, wheelStates: ctx?.wheelStates, ref: ctx?.ref }), INSIGHT_ORDER.coasting);
}

export function detectTrailBraking(telemetry: TelemetryPacket[]): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createCoreDrivingScan(telemetry)), INSIGHT_ORDER.trailBraking);
}

export function detectEarlyBraking(telemetry: TelemetryPacket[]): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createCoreDrivingScan(telemetry)), INSIGHT_ORDER.earlyBraking);
}

export function detectOverSlowing(telemetry: TelemetryPacket[]): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createCoreDrivingScan(telemetry)), INSIGHT_ORDER.overSlowing);
}

export function detectEarlyThrottle(telemetry: TelemetryPacket[], wheelStates?: readonly AllWheelStates[]): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createCoreDrivingScan(telemetry, undefined, wheelStates), { wheelStates }), INSIGHT_ORDER.earlyThrottle);
}

export function detectBinaryThrottle(telemetry: TelemetryPacket[]): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createCoreDrivingScan(telemetry)), INSIGHT_ORDER.binaryThrottle);
}

export function detectDelayedThrottlePickup(telemetry: TelemetryPacket[], wheelStates?: readonly AllWheelStates[]): LapInsight | null {
  return insightAt(runSelectedInsightScan(telemetry, createCoreDrivingScan(telemetry, undefined, wheelStates), { wheelStates }), INSIGHT_ORDER.delayedThrottlePickup);
}
