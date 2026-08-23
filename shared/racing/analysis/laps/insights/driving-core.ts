import type { SemanticLapFrame } from "../semantic-frame";
import { reportableLoss, accelDeficitLoss, speedDeficitLoss, sumLosses } from "../time-loss";
import { wheelStatesFromSignals } from "../physics/vehicle";
import { groupEvents, midFrame, type TimeLossCtx } from "./types";
import type { LapInsight } from "./types";

const finite = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);

export function detectBrakeTractionLoss(telemetry: SemanticLapFrame[]): LapInsight | null {
  // Detect braking while any wheel is locked — losing traction under braking
  const flags = telemetry.map((p) => {
    if (!finite(p.brakeInput) || p.brakeInput < 30) return false;
    const ws = wheelStatesFromSignals(p.speedMps, p.steeringInput, p.wheelRotationRadPerSec);
    return ws !== null && (ws.fl.state === "lockup" || ws.fr.state === "lockup" || ws.rl.state === "lockup" || ws.rr.state === "lockup");
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

export function detectRevLimiter(telemetry: SemanticLapFrame[], ctx?: TimeLossCtx): LapInsight | null {
  const first = telemetry[0];
  const maxRpm = first?.engineMaxRpm;
  if (!finite(maxRpm) || maxRpm === 0) return null;
  const flags = telemetry.map((frame) => finite(frame.engineRpm) && frame.engineRpm >= maxRpm - 50);
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

export function detectCoasting(telemetry: SemanticLapFrame[], ctx?: TimeLossCtx): LapInsight | null {
  const flags = telemetry.map((p) => finite(p.throttleInput) && finite(p.brakeInput) && finite(p.speedMps) && p.throttleInput < 5 && p.brakeInput < 5 && p.speedMps * 2.23694 > 20);
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
              const brake = telemetry[i]?.brakeInput;
              if (finite(brake) && brake > 25) return undefined;
            }
            const speed = telemetry[s]?.speedMps;
            return finite(speed) ? speedDeficitLoss(telemetry, ctx.dt, s, e, speed) : undefined;
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

export function detectTrailBraking(telemetry: SemanticLapFrame[]): LapInsight | null {
  const brakeFlags = telemetry.map((p) => finite(p.brakeInput) && p.brakeInput > 10);
  const brakeZones = groupEvents(brakeFlags, 3);
  if (brakeZones.length === 0) return null;

  let trailBrakedCount = 0;
  for (const [start, end] of brakeZones) {
    for (let i = start; i <= end; i++) {
      const steering = telemetry[i]?.steeringInput;
      if (finite(steering) && Math.abs(steering) > 15) {
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

export function detectEarlyBraking(telemetry: SemanticLapFrame[], ctx?: TimeLossCtx): LapInsight | null {
  // Pattern: brake zone ends → sustained coast/low throttle → throttle applied while
  // still turning. Driver braked too early, lost speed, then had to accelerate mid-corner.
  const brakeFlags = telemetry.map((p) => finite(p.brakeInput) && p.brakeInput > 25);
  const brakeZones = groupEvents(brakeFlags, 3, 10);
  if (brakeZones.length === 0) return null;

  const events: [number, number][] = [];
  for (const [, brakeEnd] of brakeZones) {
    // Scan the 1.5s after brake release without bailing on individual noisy frames:
    // count coast frames, and fire on the first solid throttle application in a turn.
    let gapFrames = 0;
    for (let i = brakeEnd + 1; i < Math.min(brakeEnd + 90, telemetry.length); i++) {
      const frame = telemetry[i];
      if (!frame || !finite(frame.brakeInput) || !finite(frame.throttleInput) || !finite(frame.steeringInput)) break;
      if (frame.brakeInput > 25) break; // next brake zone — stop scanning this corner
      if (frame.throttleInput < 50) {
        gapFrames++;
      } else if (frame.throttleInput > 140 && Math.abs(frame.steeringInput) > 25) {
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
    timeLossS: ctx
      ? reportableLoss(
          sumLosses(
            events.map(([s, e]) => {
              const speed = telemetry[s]?.speedMps;
              return finite(speed) ? speedDeficitLoss(telemetry, ctx.dt, s, e, speed) : undefined;
            }),
          ),
        )
      : undefined,
  };
}

export function detectOverSlowing(telemetry: SemanticLapFrame[], ctx?: TimeLossCtx): LapInsight | null {
  // Over-slowed corner entry: driver scrubs off too much speed, then has to get back
  // on the throttle before the corner is done. Signature: speed keeps falling after
  // brake release, hits a minimum well below the brake-release speed, then the driver
  // re-accelerates while still carrying significant steering.
  const brakeFlags = telemetry.map((p) => finite(p.brakeInput) && p.brakeInput > 25);
  const brakeZones = groupEvents(brakeFlags, 5, 10);
  if (brakeZones.length === 0) return null;

  const events: [number, number][] = [];
  for (const [, brakeEnd] of brakeZones) {
    const releaseSpeed = telemetry[brakeEnd]?.speedMps;
    if (!finite(releaseSpeed) || releaseSpeed * 2.23694 < 25) continue; // ignore pit/very slow sections

    // Find the local speed minimum within 2s of brake release
    let minIdx = brakeEnd;
    let minSpeed = releaseSpeed;
    const scanEnd = Math.min(brakeEnd + 120, telemetry.length - 1);
    for (let i = brakeEnd + 1; i <= scanEnd; i++) {
      const frame = telemetry[i];
      if (!frame || !finite(frame.brakeInput) || !finite(frame.speedMps)) break;
      if (frame.brakeInput > 25) break; // next brake zone
      if (frame.speedMps < minSpeed) {
        minSpeed = frame.speedMps;
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
      const frame = telemetry[i];
      if (frame && finite(frame.throttleInput) && finite(frame.steeringInput) && frame.throttleInput > 80 && Math.abs(frame.steeringInput) > 25) {
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
    timeLossS: ctx
      ? reportableLoss(
          sumLosses(
            events.map(([s, e]) => {
              const speed = telemetry[s]?.speedMps;
              return finite(speed) ? speedDeficitLoss(telemetry, ctx.dt, s, e, speed) : undefined;
            }),
          ),
        )
      : undefined,
  };
}

export function detectCounterSteer(telemetry: SemanticLapFrame[]): LapInsight | null {
  // Car is rotating one way (yaw rate) but driver is steering the opposite way to catch a slide
  // AngularVelocityY = yaw rate (rad/s), Steer = -128 to 127
  // Positive yaw + negative steer (or vice versa) at speed = counter-steering
  const flags = telemetry.map((p) => {
    if (!finite(p.speedMps) || !finite(p.yawRateRadPerSec) || !finite(p.steeringInput) || p.speedMps * 2.23694 < 20) return false; // skip low speed
    const yawRate = p.yawRateRadPerSec;
    const steer = p.steeringInput;
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

export function detectThrottleTractionLoss(telemetry: SemanticLapFrame[]): LapInsight | null {
  // Heavy throttle + any wheel spinning = losing drive
  const flags = telemetry.map((p) => {
    if (!finite(p.throttleInput) || p.throttleInput < 150) return false;
    const ws = wheelStatesFromSignals(p.speedMps, p.steeringInput, p.wheelRotationRadPerSec);
    return ws !== null && (ws.fl.state === "spin" || ws.fr.state === "spin" || ws.rl.state === "spin" || ws.rr.state === "spin");
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

export function detectEarlyThrottle(telemetry: SemanticLapFrame[]): LapInsight | null {
  // Applying throttle while still carrying significant steering = risk of snap oversteer
  const flags = telemetry.map((p) => {
    return finite(p.throttleInput) && finite(p.steeringInput) && finite(p.speedMps) && p.throttleInput > 100 && Math.abs(p.steeringInput) > 40 && p.speedMps * 2.23694 > 30;
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

export function detectBinaryThrottle(telemetry: SemanticLapFrame[]): LapInsight | null {
  // Count frames where throttle is either <10% or >90% while at speed
  let binaryFrames = 0;
  let totalDrivingFrames = 0;
  for (const p of telemetry) {
    if (!finite(p.speedMps) || !finite(p.throttleInput) || p.speedMps * 2.23694 < 15) continue; // skip low speed (pit, start)
    totalDrivingFrames++;
    if (p.throttleInput < 25 || p.throttleInput > 230) binaryFrames++;
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
