import type { SemanticLapFrame } from "../semantic-frame";
import { reportableLoss, accelDeficitLoss, sumLosses } from "../time-loss";
import { steerBalanceFromSignals, wheelStatesFromSignals } from "../physics/vehicle";
import { groupEvents, midFrame, type TimeLossCtx } from "./types";
import type { LapInsight } from "./types";
const finite = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);

function balance(frame: SemanticLapFrame) {
  if (!finite(frame.speedMps) || !finite(frame.accelerationXMps2) || !finite(frame.yawRateRadPerSec)) return null;
  return steerBalanceFromSignals({
    speedMps: frame.speedMps,
    accelerationX: frame.accelerationXMps2,
    yawRate: frame.yawRateRadPerSec,
  });
}

export function detectBrakeDrag(telemetry: SemanticLapFrame[]): LapInsight | null {
  // Flag frames where throttle is applied AND brake is lightly applied simultaneously
  const flags = telemetry.map((p) => {
    if (!finite(p.throttleInput) || !finite(p.brakeInput)) return false;
    const throttle = p.throttleInput / 255;
    const brake = p.brakeInput / 255;
    return throttle > 0.5 && brake > 0.005 && brake < 0.25;
  });

  const events = groupEvents(flags, 15); // ~0.25s at 60Hz
  if (events.length === 0) return null;

  // Calculate total time lost
  let totalFrames = 0;
  for (const [s, e] of events) totalFrames += e - s + 1;
  const totalSeconds = totalFrames / 60;

  return {
    id: "driving-brake-drag",
    category: "driving",
    severity: totalSeconds > 3 ? "critical" : totalSeconds > 1 ? "warning" : "info",
    label: "Brake Drag",
    detail: `Brake applied while on full throttle ${events.length} time${events.length > 1 ? "s" : ""} (${totalSeconds.toFixed(1)}s total). Check foot position — resting on the brake pedal costs straight-line speed.`,
    frameIndices: midFrame(events),
  };
}

export function detectDownshiftOverRev(telemetry: SemanticLapFrame[]): LapInsight | null {
  // Downshift that sends the engine near the limiter — too aggressive, risks
  // rear lockup from engine braking and over-rev damage.
  const first = telemetry[0];
  const maxRpm = first?.engineMaxRpm;
  if (!finite(maxRpm) || maxRpm === 0) return null;

  const eventFrames: number[] = [];
  let lastEvent = -60;
  for (let i = 1; i < telemetry.length; i++) {
    const previous = telemetry[i - 1];
    const current = telemetry[i];
    if (!previous || !current || !finite(current.gear) || !finite(previous.gear) || !(current.gear > 0 && previous.gear > current.gear)) continue;
    // RPM spike within 0.3s of the downshift
    for (let j = i; j < Math.min(i + 18, telemetry.length); j++) {
      const frame = telemetry[j];
      if (frame && finite(frame.engineRpm) && frame.engineRpm >= maxRpm * 0.97) {
        if (i - lastEvent >= 60) {
          eventFrames.push(j);
          lastEvent = i;
        }
        break;
      }
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

export function detectLateBrakingOvershoot(telemetry: SemanticLapFrame[]): LapInsight | null {
  // Carried too much speed into the corner: still braking hard while turning
  // hard, with the front tires scrubbing (understeer) — the opposite fault of
  // over-slowing.
  const brakeFlags = telemetry.map((p) => finite(p.brakeInput) && p.brakeInput > 25);
  const brakeZones = groupEvents(brakeFlags, 5, 10);
  if (brakeZones.length === 0) return null;

  const events: [number, number][] = [];
  for (const [start, end] of brakeZones) {
    let overlapFrames = 0;
    let peakFrame = start;
    for (let i = start; i <= end; i++) {
      const frame = telemetry[i];
      if (
        !frame ||
        !finite(frame.brakeInput) ||
        !finite(frame.steeringInput) ||
        !finite(frame.speedMps) ||
        frame.brakeInput <= 90 ||
        Math.abs(frame.steeringInput) <= 35 ||
        frame.speedMps * 2.23694 <= 30
      )
        continue;
      const bal = balance(frame);
      if (bal?.state === "understeer" && bal.severity > 0.3) {
        overlapFrames++;
        peakFrame = i;
      }
    }
    if (overlapFrames >= 10) events.push([start, peakFrame]); // ≥~0.17s of hard-brake understeer
  }

  if (events.length === 0) return null;
  return {
    id: "driving-late-braking-overshoot",
    category: "driving",
    severity: events.length >= 3 ? "warning" : "info",
    label: "Late Braking Overshoot",
    detail: `${events.length} corner${events.length > 1 ? "s" : ""} — still braking hard with heavy steering and front scrub. Brake earlier or release sooner to rotate.`,
    frameIndices: events.map(([, peak]) => peak),
  };
}

export function detectUndersteerScrub(telemetry: SemanticLapFrame[]): LapInsight | null {
  // Sustained understeer mid-corner: lots of steering, front slip well above
  // rear — the fronts are sliding, adding steering won't help.
  const flags = telemetry.map((p) => {
    if (!finite(p.speedMps) || !finite(p.steeringInput) || p.speedMps * 2.23694 < 30 || Math.abs(p.steeringInput) < 25) return false;
    const bal = balance(p);
    return bal?.state === "understeer" && bal.severity > 0.4;
  });
  const events = groupEvents(flags, 10, 20);
  if (events.length === 0) return null;
  const totalFrames = events.reduce((s, [a, b]) => s + (b - a + 1), 0);
  return {
    id: "driving-understeer-scrub",
    category: "driving",
    severity: events.length >= 4 || totalFrames > 180 ? "warning" : "info",
    label: "Understeer Scrub",
    detail: `${events.length} corner${events.length > 1 ? "s" : ""} with sustained front scrub (${(totalFrames / 60).toFixed(1)}s total) — slow entry slightly or open the steering to regain front grip`,
    frameIndices: midFrame(events),
  };
}

export function detectSteeringSawing(telemetry: SemanticLapFrame[]): LapInsight | null {
  // High-frequency steering reversals mid-corner — fighting the car or
  // overdriving. Count direction flips of the steering derivative.
  const reversal: boolean[] = new Array(telemetry.length).fill(false);
  let lastDir = 0;
  for (let i = 1; i < telemetry.length; i++) {
    const frame = telemetry[i];
    if (!frame || !finite(frame.steeringInput) || !finite(frame.speedMps) || Math.abs(frame.steeringInput) < 15 || frame.speedMps * 2.23694 < 40) {
      lastDir = 0;
      continue;
    }
    const previousSteer = telemetry[i - 1]?.steeringInput;
    if (!finite(previousSteer)) continue;
    const delta = frame.steeringInput - previousSteer;
    if (Math.abs(delta) < 5) continue;
    const direction = Math.sign(delta);
    if (lastDir !== 0 && direction !== lastDir) reversal[i] = true;
    lastDir = direction;
  }

  // Flag windows with ≥4 reversals per second
  const flags: boolean[] = new Array(telemetry.length).fill(false);
  let count = 0;
  for (let i = 0; i < telemetry.length; i++) {
    if (reversal[i]) count++;
    if (i >= 60 && reversal[i - 60]) count--;
    if (count >= 4) flags[i] = true;
  }
  const events = groupEvents(flags, 10, 30);
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

export function detectThrottleMicroLifts(telemetry: SemanticLapFrame[], ctx?: TimeLossCtx): LapInsight | null {
  // Repeated small throttle lifts under power with the rear breaking loose —
  // manually doing traction control's job. Signature: near-full throttle,
  // sharp dip, quick recovery, with wheelspin nearby.
  const liftFrames: number[] = [];
  const liftWindows: [number, number][] = [];
  let i = 1;
  while (i < telemetry.length - 1) {
    const previous = telemetry[i - 1];
    const current = telemetry[i];
    if (previous && current && finite(previous.throttleInput) && finite(current.throttleInput) && previous.throttleInput > 180 && previous.throttleInput - current.throttleInput >= 60) {
      // Find recovery within 20 frames
      let recovered = -1;
      for (let j = i + 1; j < Math.min(i + 20, telemetry.length); j++) {
        const frame = telemetry[j];
        const brake = frame?.brakeInput;
        const throttle = frame?.throttleInput;
        if (!finite(brake) || !finite(throttle) || brake > 25) break;
        if (throttle > 180) {
          recovered = j;
          break;
        }
      }
      if (recovered !== -1) {
        // Require rear slip near the lift to distinguish from deliberate lifts
        let slipNearby = false;
        for (let j = Math.max(0, i - 10); j <= Math.min(recovered + 10, telemetry.length - 1); j++) {
          const frame = telemetry[j];
          if (!frame) continue;
          const wheelStates = wheelStatesFromSignals(frame.speedMps, frame.steeringInput, frame.wheelRotationRadPerSec);
          if (wheelStates !== null && (wheelStates.rl.state === "spin" || wheelStates.rr.state === "spin")) {
            slipNearby = true;
            break;
          }
        }
        if (slipNearby) {
          liftFrames.push(i);
          liftWindows.push([i - 1, recovered]);
        }
        i = recovered + 1;
        continue;
      }
    }
    i++;
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

export function detectKerbRiding(telemetry: SemanticLapFrame[]): LapInsight | null {
  // Hard kerb strikes: wheel on a rumble strip (when the game reports it)
  // combined with a sharp suspension compression spike at speed. Games that
  // don't report rumble strips (F1, AC Evo) fall back to the spike alone.
  const hasRumble = telemetry.some((p) => p.wheelOnRumbleStrip[0] === true || p.wheelOnRumbleStrip[1] === true || p.wheelOnRumbleStrip[2] === true || p.wheelOnRumbleStrip[3] === true);

  const flags: boolean[] = new Array(telemetry.length).fill(false);
  for (let i = 1; i < telemetry.length; i++) {
    const frame = telemetry[i];
    const previous = telemetry[i - 1];
    if (!frame || !previous) continue;
    const [fl, fr, rl, rr] = frame.normalizedSuspensionTravel;
    const [previousFl, previousFr, previousRl, previousRr] = previous.normalizedSuspensionTravel;
    if (
      !finite(frame.speedMps) ||
      frame.speedMps * 2.23694 < 30 ||
      !finite(fl) ||
      !finite(fr) ||
      !finite(rl) ||
      !finite(rr) ||
      !finite(previousFl) ||
      !finite(previousFr) ||
      !finite(previousRl) ||
      !finite(previousRr)
    )
      continue;
    const spike = Math.max(Math.abs(fl - previousFl), Math.abs(fr - previousFr), Math.abs(rl - previousRl), Math.abs(rr - previousRr));
    if (hasRumble) {
      const onKerb = frame.wheelOnRumbleStrip[0] === true || frame.wheelOnRumbleStrip[1] === true || frame.wheelOnRumbleStrip[2] === true || frame.wheelOnRumbleStrip[3] === true;
      flags[i] = onKerb && spike > 0.1;
    } else {
      flags[i] = spike > 0.18; // spike-only needs a stronger signal
    }
  }
  const events = groupEvents(flags, 2, 20);
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
