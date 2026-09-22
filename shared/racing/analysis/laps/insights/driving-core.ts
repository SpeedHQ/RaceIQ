import type { TelemetryPacket } from "../../../../telemetry/types";
import { reportableLoss, accelDeficitLoss, speedDeficitLoss, sumLosses } from "../time-loss";
import type { AllWheelStates } from "../physics/vehicle";
import { eventDurations, eventSeconds, groupEvents, midFrame, type TimeLossCtx } from "./types";
import type { LapInsight } from "./types";

export function detectBrakeTractionLoss(telemetry: TelemetryPacket[], wheelStates: readonly AllWheelStates[]): LapInsight | null {
  // Detect braking while any wheel is locked — losing traction under braking
  const flags = telemetry.map((p, i) => {
    if (p.Brake < 30) return false; // must be braking
    const ws = wheelStates[i];
    return ws.fl.state === "lockup" || ws.fr.state === "lockup" || ws.rl.state === "lockup" || ws.rr.state === "lockup";
  });
  const events = groupEvents(flags, eventDurations(telemetry), 3 / 60, 15 / 60);
  if (events.length === 0) return null;
  return {
    id: "driving-brake-traction-loss",
    category: "driving",
    severity: events.length >= 5 ? "critical" : events.length >= 2 ? "warning" : "info",
    label: "Brake Traction Loss",
    detail: `${events.length} lockup${events.length > 1 ? "s" : ""} under braking`,
    frameIndices: midFrame(events),
  };
}

export function detectRevLimiter(telemetry: TelemetryPacket[], ctx?: TimeLossCtx): LapInsight | null {
  if (telemetry.length === 0) return null;
  const maxRpm = telemetry[0].EngineMaxRpm;
  if (maxRpm === 0) return null;
  const flags = telemetry.map((p) => p.CurrentEngineRpm >= maxRpm - 50);
  const events = groupEvents(flags, eventDurations(telemetry), 10 / 60, 20 / 60);
  if (events.length === 0) return null;
  // On the limiter the car stops accelerating; the cost is the acceleration it
  // would still have had in the next gear. Assumes an upshift was available —
  // if the driver was already in top gear this over-charges slightly.
  const timeLossS = ctx ? reportableLoss(sumLosses(events.map(([s, e]) => accelDeficitLoss(telemetry, ctx.dt, s, e, ctx.ref)))) : undefined;
  return {
    id: "driving-rev-limiter",
    category: "driving",
    severity: events.length >= 5 ? "warning" : "info",
    label: "Rev Limiter",
    detail: `Hit limiter ${events.length} time${events.length > 1 ? "s" : ""}`,
    frameIndices: midFrame(events),
    timeLossS,
  };
}

export function detectCoasting(telemetry: TelemetryPacket[], ctx?: TimeLossCtx): LapInsight | null {
  const dt = eventDurations(telemetry);
  const flags = telemetry.map((p) => p.Accel < 5 && p.Brake < 5 && p.Speed * 2.23694 > 20);
  const events = groupEvents(flags, dt, 0.5);
  if (events.length === 0) return null;
  const totalSeconds = events.reduce((s, [a, b]) => s + eventSeconds(dt, a, b, flags), 0);
  const lapSeconds = eventSeconds(dt, 0, dt.length - 1);

  // Only charge coasting that wasn't corner entry: a coast which runs straight
  // into braking is the driver releasing early on purpose, not dead time.
  const timeLossS = ctx
    ? reportableLoss(
        sumLosses(
          events.map(([s, e]) => {
            for (let i = e + 1, elapsed = 0; i < telemetry.length && elapsed < 0.5; i++) {
              if (dt[i - 1] <= 0 || dt[i] <= 0) return undefined;
              elapsed += dt[i];
              if (telemetry[i].Brake > 25) return undefined;
            }
            return speedDeficitLoss(telemetry, ctx.dt, s, e, telemetry[s].Speed);
          }),
        ),
      )
    : undefined;

  return {
    id: "driving-coasting",
    category: "driving",
    severity: totalSeconds > 2 ? "warning" : "info",
    label: "Coasting",
    detail: `${events.length} zone${events.length > 1 ? "s" : ""}, ${((totalSeconds / lapSeconds) * 100).toFixed(1)}% of lap`,
    frameIndices: midFrame(events),
    timeLossS,
  };
}

export function detectTrailBraking(telemetry: TelemetryPacket[]): LapInsight | null {
  const brakeFlags = telemetry.map((p) => p.Brake > 10);
  const brakeZones = groupEvents(brakeFlags, eventDurations(telemetry), 3 / 60);
  if (brakeZones.length === 0) return null;

  let trailBrakedCount = 0;
  for (const [start, end] of brakeZones) {
    for (let i = start; i <= end; i++) {
      if (Math.abs(telemetry[i].Steer) > 15) {
        trailBrakedCount++;
        break;
      }
    }
  }
  const pct = (trailBrakedCount / brakeZones.length) * 100;
  return {
    id: "driving-trail-brake",
    category: "driving",
    severity: "info",
    label: "Trail Braking",
    detail: `${trailBrakedCount}/${brakeZones.length} brake zones (${pct.toFixed(0)}%)`,
    frameIndices: midFrame(brakeZones),
  };
}

export function detectEarlyBraking(telemetry: TelemetryPacket[]): LapInsight | null {
  const dt = eventDurations(telemetry);
  const brakeZones = groupEvents(telemetry.map((p) => p.Brake > 25), dt, 3 / 60, 10 / 60);
  const events: [number, number][] = [];
  for (const [, brakeEnd] of brakeZones) {
    let coastSeconds = 0;
    for (let i = brakeEnd + 1, elapsed = 0; i < telemetry.length && elapsed < 1.5; i++) {
      if (dt[i - 1] <= 0 || dt[i] <= 0) break;
      elapsed += dt[i];
      const p = telemetry[i];
      if (p.Brake > 25) break;
      if (p.Accel < 50) coastSeconds += dt[i];
      else if (p.Accel > 140 && Math.abs(p.Steer) > 25) {
        if (coastSeconds >= 0.25) events.push([brakeEnd, i]);
        break;
      }
    }
  }
  if (events.length === 0) return null;
  return {
    id: "driving-early-braking",
    category: "driving",
    severity: "info",
    label: "Coast After Braking",
    detail: `${events.length} corner${events.length > 1 ? "s" : ""} — low throttle after brake release, then power while turning. Without a comparable corner reference, this does not establish early braking or lost time.`,
    frameIndices: midFrame(events),
  };
}

export function detectOverSlowing(telemetry: TelemetryPacket[]): LapInsight | null {
  const dt = eventDurations(telemetry);
  const brakeZones = groupEvents(telemetry.map((p) => p.Brake > 25), dt, 5 / 60, 10 / 60);
  const events: [number, number][] = [];
  for (const [, brakeEnd] of brakeZones) {
    const releaseSpeed = telemetry[brakeEnd].Speed;
    if (releaseSpeed * 2.23694 < 25) continue;
    let minIdx = brakeEnd;
    let minSpeed = releaseSpeed;
    for (let i = brakeEnd + 1, elapsed = 0; i < telemetry.length && elapsed < 2; i++) {
      if (dt[i - 1] <= 0 || dt[i] <= 0 || telemetry[i].Brake > 25) break;
      elapsed += dt[i];
      if (telemetry[i].Speed < minSpeed) {
        minSpeed = telemetry[i].Speed;
        minIdx = i;
      }
    }
    if ((releaseSpeed - minSpeed) / releaseSpeed < 0.08) continue;
    for (let i = minIdx, elapsed = 0; i < telemetry.length && elapsed < 1; i++) {
      if (dt[i] <= 0 || (i > minIdx && dt[i - 1] <= 0)) break;
      elapsed += dt[i];
      const p = telemetry[i];
      if (p.Brake > 25) break;
      if (p.Accel > 80 && Math.abs(p.Steer) > 25) {
        events.push([brakeEnd, minIdx]);
        break;
      }
    }
  }
  if (events.length === 0) return null;
  return {
    id: "driving-over-slowing",
    category: "driving",
    severity: "info",
    label: "Corner Speed Reduction",
    detail: `${events.length} corner${events.length > 1 ? "s" : ""} — speed fell after brake release before power resumed while turning. Corner geometry and grip may require this; excess slowing or lost time is not established.`,
    frameIndices: events.map(([, minIdx]) => minIdx),
  };
}

export function detectCounterSteer(telemetry: TelemetryPacket[]): LapInsight | null {
  // Car is rotating one way (yaw rate) but driver is steering the opposite way to catch a slide
  // AngularVelocityY = yaw rate (rad/s), Steer = -128 to 127
  // Positive yaw + negative steer (or vice versa) at speed = counter-steering
  const flags = telemetry.map((p) => {
    if (p.Speed * 2.23694 < 20) return false; // skip low speed
    const yawRate = p.AngularVelocityY;
    const steer = p.Steer;
    // Both must be significant, and in opposite directions
    return Math.abs(yawRate) > 0.3 && Math.abs(steer) > 20 && Math.sign(yawRate) !== Math.sign(steer);
  });
  const events = groupEvents(flags, eventDurations(telemetry), 3 / 60, 10 / 60);
  if (events.length === 0) return null;
  return {
    id: "driving-counter-steer",
    category: "driving",
    severity: events.length >= 5 ? "critical" : events.length >= 2 ? "warning" : "info",
    label: "Counter-Steer",
    detail: `${events.length} correction${events.length > 1 ? "s" : ""} — Loss of rear traction`,
    frameIndices: midFrame(events),
  };
}

export function detectThrottleTractionLoss(telemetry: TelemetryPacket[], wheelStates: readonly AllWheelStates[]): LapInsight | null {
  // Heavy throttle + any wheel spinning = losing drive
  const flags = telemetry.map((p, i) => {
    if (p.Accel < 150) return false;
    const ws = wheelStates[i];
    return ws.fl.state === "spin" || ws.fr.state === "spin" || ws.rl.state === "spin" || ws.rr.state === "spin";
  });
  const events = groupEvents(flags, eventDurations(telemetry), 3 / 60, 15 / 60);
  if (events.length === 0) return null;
  return {
    id: "driving-throttle-traction-loss",
    category: "driving",
    severity: events.length >= 5 ? "critical" : events.length >= 2 ? "warning" : "info",
    label: "Throttle Traction Loss",
    detail: `${events.length} wheelspin event${events.length > 1 ? "s" : ""} under power`,
    frameIndices: midFrame(events),
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

// Find an actual power-on/power-off reversal, not occupancy at pedal endpoints.
// Both transitions must occur during one continuous, same-direction turn.
function cornerThrottleReversals(telemetry: TelemetryPacket[], dt: readonly number[], high: number): boolean[] {
  const flags = new Array<boolean>(telemetry.length).fill(false);
  for (let i = 1; i < telemetry.length; i++) {
    if (telemetry[i].Accel >= 25 || telemetry[i - 1].Accel < 25) continue;
    const direction = Math.sign(telemetry[i].Steer);
    let highStart = -1;
    let highEnd = -1;
    let highSeconds = 0;
    let sawLow = false;
    for (let j = i - 1, elapsed = 0; j >= 0 && elapsed < 1; j--) {
      const p = telemetry[j];
      if (dt[j] <= 0 || !activeExit(p) || Math.sign(p.Steer) !== direction ||
        Math.abs(p.Steer) < 25 || !(Math.abs(p.AngularVelocityY) > 0.15 || Math.abs(p.AccelerationX) > 2)) break;
      elapsed += dt[j];
      if (p.Accel >= high) {
        if (highEnd < 0 && elapsed > 0.25) break;
        highStart = j;
        if (highEnd < 0) highEnd = j;
        highSeconds += dt[j];
      } else if (highStart >= 0 && p.Accel < 25) {
        sawLow = true;
        break;
      }
    }
    if (!sawLow || highSeconds < 0.1 || highStart < 0) continue;
    let lowSeconds = 0;
    for (let j = i; j < telemetry.length && lowSeconds < 0.1; j++) {
      const p = telemetry[j];
      if (dt[j] <= 0 || !activeExit(p) || p.Accel >= 25 ||
        Math.sign(p.Steer) !== direction || Math.abs(p.Steer) < 20) break;
      lowSeconds += dt[j];
    }
    if (lowSeconds < 0.1) continue;
    for (let j = highStart; j <= highEnd; j++) flags[j] = telemetry[j].Accel >= high;
  }
  return flags;
}

export function detectEarlyThrottle(telemetry: TelemetryPacket[], wheelStates?: readonly AllWheelStates[]): LapInsight | null {
  const dt = eventDurations(telemetry);
  const corrections = cornerThrottleReversals(telemetry, dt, 100);
  const flags = telemetry.map((p, i) => {
    if (!activeExit(p) || p.Accel <= 100 || Math.abs(p.Steer) <= 40) return false;
    // Magnitudes avoid assuming a game's yaw/steering sign convention.
    const excessRotation = Number.isFinite(p.AccelerationX) &&
      Math.abs(p.AngularVelocityY) > Math.abs(p.AccelerationX) / p.Speed + 0.3;
    return wheelSlipping(wheelStates?.[i]) || excessRotation || corrections[i];
  });
  const events = groupEvents(flags, dt, 0.1, 0.15);
  if (events.length === 0) return null;
  return {
    id: "driving-early-throttle",
    category: "driving",
    severity: events.length >= 5 ? "warning" : "info",
    label: "Corner Throttle Correction",
    detail: `${events.length} zone${events.length > 1 ? "s" : ""} — corner power coincided with wheelspin, excess rotation, or an abrupt corrective lift`,
    frameIndices: midFrame(events),
  };
}

export function detectBinaryThrottle(telemetry: TelemetryPacket[]): LapInsight | null {
  const dt = eventDurations(telemetry);
  const events = groupEvents(cornerThrottleReversals(telemetry, dt, 230), dt, 0.1, 0.3);
  if (events.length === 0) return null;
  return {
    id: "driving-binary-throttle",
    category: "driving",
    severity: events.length >= 3 ? "warning" : "info",
    label: "Abrupt Corner Throttle",
    detail: `${events.length} corner power reversal${events.length > 1 ? "s" : ""} — near-full throttle followed by a rapid lift while still turning`,
    frameIndices: midFrame(events),
  };
}

export function detectDelayedThrottlePickup(telemetry: TelemetryPacket[], wheelStates?: readonly AllWheelStates[]): LapInsight | null {
  const dt = eventDurations(telemetry);
  const turns = groupEvents(telemetry.map((p) => activeExit(p) && Math.abs(p.Steer) >= 30), dt, 0.25, 0.1);
  const events: [number, number][] = [];
  for (const [start, end] of turns) {
    let peakSteer = 0;
    let apexSpeed = Infinity;
    const direction = Math.sign(telemetry[start].Steer);
    let valid = true;
    for (let i = start; i <= end; i++) {
      peakSteer = Math.max(peakSteer, Math.abs(telemetry[i].Steer));
      apexSpeed = Math.min(apexSpeed, telemetry[i].Speed);
      if (Math.sign(telemetry[i].Steer) !== direction) valid = false;
    }
    if (!valid) continue;
    let stableStart = -1;
    let stableEnd = -1;
    let stableSeconds = 0;
    let pickup = -1;
    let elapsed = 0;
    // Repository corner semantics use minimum speed as apex and steering unwind
    // as exit. Keep this local: server corner extraction is sample-based.
    for (let i = end + 1; i < telemetry.length && elapsed < 3; i++) {
      const p = telemetry[i];
      if (dt[i - 1] <= 0 || dt[i] <= 0 || !activeExit(p) ||
        (Math.abs(p.Steer) > 10 && Math.sign(p.Steer) !== direction) ||
        Math.abs(p.Steer) > Math.abs(telemetry[i - 1].Steer) + 5) {
        valid = false;
        break;
      }
      elapsed += dt[i];
      const ws = wheelStates?.[i];
      const stableGrip = !ws || (ws.fl.state === "grip" && ws.fr.state === "grip" &&
        ws.rl.state === "grip" && ws.rr.state === "grip");
      const unloaded = Number.isFinite(p.AccelerationX) && Number.isFinite(p.AngularVelocityY) &&
        Math.abs(p.AccelerationX) < 4 && Math.abs(p.AngularVelocityY) * p.Speed < 4 &&
        Math.abs(p.AngularVelocityY - telemetry[i - 1].AngularVelocityY) / dt[i - 1] < 1.5;
      if (!stableGrip || !unloaded) {
        if (stableStart >= 0) valid = false;
        if (!valid) break;
        continue;
      }
      if (p.Accel >= 80) {
        pickup = i;
        break;
      }
      if (Math.abs(p.Steer) <= Math.min(18, peakSteer * 0.45) && p.Speed >= apexSpeed * 0.98 && p.Accel < 50) {
        if (stableStart < 0) stableStart = i;
        stableEnd = i;
        stableSeconds += dt[i];
      } else if (stableStart >= 0) {
        valid = false;
        break;
      }
    }
    if (!valid || stableSeconds < 0.6 || stableStart < 0) continue;
    // A nearby second turn or brake application makes this a transition, not
    // a clean exit opportunity. Require recorded lookahead, including at EOF.
    const last = pickup >= 0 ? pickup : stableEnd;
    let lookahead = 0;
    for (let i = last + 1; i < telemetry.length && lookahead < 0.5; i++) {
      const p = telemetry[i];
      if (dt[i - 1] <= 0 || dt[i] <= 0 || !activeExit(p) || Math.abs(p.Steer) > 25 ||
        (Math.abs(p.Steer) > 10 && Math.sign(p.Steer) !== direction)) {
        valid = false;
        break;
      }
      lookahead += dt[i];
    }
    if (valid && lookahead >= 0.5) events.push([stableStart, stableEnd]);
  }
  if (events.length === 0) return null;
  return {
    id: "driving-delayed-throttle-pickup",
    category: "driving",
    severity: "info",
    label: "Low Throttle After Unwind",
    detail: `${events.length} exit${events.length > 1 ? "s" : ""} — low throttle continued after steering and lateral load reduced. No matched clean-corner reference; available grip and time loss are not established.`,
    frameIndices: midFrame(events),
  };
}
