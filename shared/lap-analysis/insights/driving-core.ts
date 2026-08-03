import type { TelemetryPacket } from "../../telemetry/types";
import { reportableLoss, accelDeficitLoss, speedDeficitLoss, sumLosses } from "../time-loss";
import { allWheelStates } from "../physics/vehicle";
import { groupEvents, midFrame, type TimeLossCtx } from "./types";
import type { LapInsight } from "./types";

export function detectBrakeTractionLoss(telemetry: TelemetryPacket[]): LapInsight | null {
  // Detect braking while any wheel is locked — losing traction under braking
  const flags = telemetry.map((p) => {
    if (p.Brake < 30) return false; // must be braking
    const ws = allWheelStates(p);
    return ws.fl.state === "lockup" || ws.fr.state === "lockup" || ws.rl.state === "lockup" || ws.rr.state === "lockup";
  });
  const events = groupEvents(flags, 3, 15);
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
  const events = groupEvents(flags, 10, 20);
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
  const flags = telemetry.map((p) => p.Accel < 5 && p.Brake < 5 && p.Speed * 2.23694 > 20);
  const events = groupEvents(flags, 30);
  if (events.length === 0) return null;
  const totalFrames = events.reduce((s, [a, b]) => s + (b - a + 1), 0);

  // Only charge coasting that wasn't corner entry: a coast which runs straight
  // into braking is the driver releasing early on purpose, not dead time.
  const timeLossS = ctx
    ? reportableLoss(
        sumLosses(
          events.map(([s, e]) => {
            for (let i = e + 1; i < Math.min(e + 31, telemetry.length); i++) {
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
    severity: totalFrames > 120 ? "warning" : "info",
    label: "Coasting",
    detail: `${events.length} zone${events.length > 1 ? "s" : ""}, ${((totalFrames / telemetry.length) * 100).toFixed(1)}% of lap`,
    frameIndices: midFrame(events),
    timeLossS,
  };
}

export function detectTrailBraking(telemetry: TelemetryPacket[]): LapInsight | null {
  const brakeFlags = telemetry.map((p) => p.Brake > 10);
  const brakeZones = groupEvents(brakeFlags, 3);
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

export function detectEarlyBraking(telemetry: TelemetryPacket[], ctx?: TimeLossCtx): LapInsight | null {
  // Pattern: brake zone ends → sustained coast/low throttle → throttle applied while
  // still turning. Driver braked too early, lost speed, then had to accelerate mid-corner.
  const brakeFlags = telemetry.map((p) => p.Brake > 25);
  const brakeZones = groupEvents(brakeFlags, 3, 10);
  if (brakeZones.length === 0) return null;

  const events: [number, number][] = [];
  for (const [, brakeEnd] of brakeZones) {
    // Scan the 1.5s after brake release without bailing on individual noisy frames:
    // count coast frames, and fire on the first solid throttle application in a turn.
    let gapFrames = 0;
    for (let i = brakeEnd + 1; i < Math.min(brakeEnd + 90, telemetry.length); i++) {
      const p = telemetry[i];
      if (p.Brake > 25) break; // next brake zone — stop scanning this corner
      if (p.Accel < 50) {
        gapFrames++;
      } else if (p.Accel > 140 && Math.abs(p.Steer) > 25) {
        if (gapFrames >= 15) events.push([brakeEnd, i]); // ≥0.25s coast then power mid-turn
        break;
      }
      // partial throttle (50–140) neither counts as coast nor triggers — keep scanning
    }
  }

  if (events.length === 0) return null;
  return {
    id: "driving-early-braking",
    category: "driving",
    severity: events.length >= 4 ? "warning" : "info",
    label: "Early Braking",
    detail: `${events.length} corner${events.length > 1 ? "s" : ""} — braked early, coasted, then had to accelerate mid-turn`,
    frameIndices: midFrame(events),
    // The gap between brake release and throttle is dead time by this
    // detector's own definition, so brake-release speed is the counterfactual.
    timeLossS: ctx ? reportableLoss(sumLosses(events.map(([s, e]) => speedDeficitLoss(telemetry, ctx.dt, s, e, telemetry[s].Speed)))) : undefined,
  };
}

export function detectOverSlowing(telemetry: TelemetryPacket[], ctx?: TimeLossCtx): LapInsight | null {
  // Over-slowed corner entry: driver scrubs off too much speed, then has to get back
  // on the throttle before the corner is done. Signature: speed keeps falling after
  // brake release, hits a minimum well below the brake-release speed, then the driver
  // re-accelerates while still carrying significant steering.
  const brakeFlags = telemetry.map((p) => p.Brake > 25);
  const brakeZones = groupEvents(brakeFlags, 5, 10);
  if (brakeZones.length === 0) return null;

  const events: [number, number][] = [];
  for (const [, brakeEnd] of brakeZones) {
    const releaseSpeed = telemetry[brakeEnd].Speed;
    if (releaseSpeed * 2.23694 < 25) continue; // ignore pit/very slow sections

    // Find the local speed minimum within 2s of brake release
    let minIdx = brakeEnd;
    let minSpeed = releaseSpeed;
    const scanEnd = Math.min(brakeEnd + 120, telemetry.length - 1);
    for (let i = brakeEnd + 1; i <= scanEnd; i++) {
      if (telemetry[i].Brake > 25) break; // next brake zone
      if (telemetry[i].Speed < minSpeed) {
        minSpeed = telemetry[i].Speed;
        minIdx = i;
      }
    }

    // Speed kept dropping ≥8% after the brakes were already released — the slowing
    // wasn't done by the brakes, the driver just ran out of momentum.
    const extraScrub = (releaseSpeed - minSpeed) / releaseSpeed;
    if (extraScrub < 0.08) continue;

    // And the driver had to pick the throttle back up while still mid-corner
    let reaccelerated = false;
    for (let i = minIdx; i <= Math.min(minIdx + 60, telemetry.length - 1); i++) {
      const p = telemetry[i];
      if (p.Accel > 80 && Math.abs(p.Steer) > 25) {
        reaccelerated = true;
        break;
      }
    }
    if (reaccelerated) events.push([brakeEnd, minIdx]);
  }

  if (events.length === 0) return null;
  return {
    id: "driving-over-slowing",
    category: "driving",
    severity: events.length >= 4 ? "warning" : "info",
    label: "Over-Slowed Corner",
    detail: `${events.length} corner${events.length > 1 ? "s" : ""} — scrubbed extra speed after brake release, then re-accelerated mid-turn. Carry more entry speed or brake later/lighter.`,
    frameIndices: events.map(([, minIdx]) => minIdx),
    // Counterfactual is the speed the driver had at brake release: the detector
    // only fires when the extra scrub happened with the brakes already off.
    timeLossS: ctx ? reportableLoss(sumLosses(events.map(([s, e]) => speedDeficitLoss(telemetry, ctx.dt, s, e, telemetry[s].Speed)))) : undefined,
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
  const events = groupEvents(flags, 3, 10);
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

export function detectThrottleTractionLoss(telemetry: TelemetryPacket[]): LapInsight | null {
  // Heavy throttle + any wheel spinning = losing drive
  const flags = telemetry.map((p) => {
    if (p.Accel < 150) return false;
    const ws = allWheelStates(p);
    return ws.fl.state === "spin" || ws.fr.state === "spin" || ws.rl.state === "spin" || ws.rr.state === "spin";
  });
  const events = groupEvents(flags, 3, 15);
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

export function detectEarlyThrottle(telemetry: TelemetryPacket[]): LapInsight | null {
  // Applying throttle while still carrying significant steering = risk of snap oversteer
  const flags = telemetry.map((p) => {
    return p.Accel > 100 && Math.abs(p.Steer) > 40 && p.Speed * 2.23694 > 30;
  });
  const events = groupEvents(flags, 5);
  if (events.length === 0) return null;
  return {
    id: "driving-early-throttle",
    category: "driving",
    severity: events.length >= 5 ? "warning" : "info",
    label: "Early Throttle",
    detail: `${events.length} zone${events.length > 1 ? "s" : ""} — throttle applied with heavy steering`,
    frameIndices: midFrame(events),
  };
}

export function detectBinaryThrottle(telemetry: TelemetryPacket[]): LapInsight | null {
  // Count frames where throttle is either <10% or >90% while at speed
  let binaryFrames = 0;
  let totalDrivingFrames = 0;
  for (const p of telemetry) {
    if (p.Speed * 2.23694 < 15) continue; // skip low speed (pit, start)
    totalDrivingFrames++;
    if (p.Accel < 25 || p.Accel > 230) binaryFrames++;
  }
  if (totalDrivingFrames < 100) return null;
  const pct = (binaryFrames / totalDrivingFrames) * 100;
  if (pct < 70) return null; // some binary input is normal
  return {
    id: "driving-binary-throttle",
    category: "driving",
    severity: pct > 90 ? "warning" : "info",
    label: "Binary Throttle",
    detail: `${pct.toFixed(0)}% of driving is full-on or full-off`,
    frameIndices: [Math.round(telemetry.length / 2)],
  };
}

