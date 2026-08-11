import type { TelemetryPacket } from "../../../../telemetry/types";
import { reportableLoss, accelDeficitLoss, sumLosses } from "../time-loss";
import { allWheelStates, steerBalance } from "../physics/vehicle";
import { groupEvents, midFrame, type TimeLossCtx } from "./types";
import type { LapInsight } from "./types";

export function detectBrakeDrag(telemetry: TelemetryPacket[]): LapInsight | null {
  // Flag frames where throttle is applied AND brake is lightly applied simultaneously
  const flags = telemetry.map((p) => {
    const throttle = p.Accel / 255;
    const brake = p.Brake / 255;
    // Throttle > 50% with light brake (0.5-25%) — not intentional trail braking or hard braking
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

export function detectDownshiftOverRev(telemetry: TelemetryPacket[]): LapInsight | null {
  // Downshift that sends the engine near the limiter — too aggressive, risks
  // rear lockup from engine braking and over-rev damage.
  if (telemetry.length === 0) return null;
  const maxRpm = telemetry[0].EngineMaxRpm;
  if (maxRpm === 0) return null;

  const eventFrames: number[] = [];
  let lastEvent = -60;
  for (let i = 1; i < telemetry.length; i++) {
    const prev = telemetry[i - 1];
    const cur = telemetry[i];
    if (!(cur.Gear > 0 && prev.Gear > cur.Gear)) continue;
    // RPM spike within 0.3s of the downshift
    for (let j = i; j < Math.min(i + 18, telemetry.length); j++) {
      if (telemetry[j].CurrentEngineRpm >= maxRpm * 0.97) {
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

export function detectLateBrakingOvershoot(telemetry: TelemetryPacket[]): LapInsight | null {
  // Carried too much speed into the corner: still braking hard while turning
  // hard, with the front tires scrubbing (understeer) — the opposite fault of
  // over-slowing.
  const brakeFlags = telemetry.map((p) => p.Brake > 25);
  const brakeZones = groupEvents(brakeFlags, 5, 10);
  if (brakeZones.length === 0) return null;

  const events: [number, number][] = [];
  for (const [start, end] of brakeZones) {
    let overlapFrames = 0;
    let peakFrame = start;
    for (let i = start; i <= end; i++) {
      const p = telemetry[i];
      if (p.Brake > 90 && Math.abs(p.Steer) > 35 && p.Speed * 2.23694 > 30) {
        const bal = steerBalance(p);
        if (bal.state === "understeer" && bal.severity > 0.3) {
          overlapFrames++;
          peakFrame = i;
        }
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

export function detectUndersteerScrub(telemetry: TelemetryPacket[]): LapInsight | null {
  // Sustained understeer mid-corner: lots of steering, front slip well above
  // rear — the fronts are sliding, adding steering won't help.
  const flags = telemetry.map((p) => {
    if (p.Speed * 2.23694 < 30 || Math.abs(p.Steer) < 25) return false;
    const bal = steerBalance(p);
    return bal.state === "understeer" && bal.severity > 0.4;
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

export function detectSteeringSawing(telemetry: TelemetryPacket[]): LapInsight | null {
  // High-frequency steering reversals mid-corner — fighting the car or
  // overdriving. Count direction flips of the steering derivative.
  const reversal: boolean[] = new Array(telemetry.length).fill(false);
  let lastDir = 0;
  for (let i = 1; i < telemetry.length; i++) {
    const p = telemetry[i];
    if (Math.abs(p.Steer) < 15 || p.Speed * 2.23694 < 40) {
      lastDir = 0;
      continue;
    }
    const d = p.Steer - telemetry[i - 1].Steer;
    if (Math.abs(d) < 5) continue;
    const dir = Math.sign(d);
    if (lastDir !== 0 && dir !== lastDir) reversal[i] = true;
    lastDir = dir;
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

export function detectThrottleMicroLifts(telemetry: TelemetryPacket[], ctx?: TimeLossCtx): LapInsight | null {
  // Repeated small throttle lifts under power with the rear breaking loose —
  // manually doing traction control's job. Signature: near-full throttle,
  // sharp dip, quick recovery, with wheelspin nearby.
  const liftFrames: number[] = [];
  const liftWindows: [number, number][] = [];
  let i = 1;
  while (i < telemetry.length - 1) {
    const prev = telemetry[i - 1];
    const cur = telemetry[i];
    if (prev.Accel > 180 && prev.Accel - cur.Accel >= 60) {
      // Find recovery within 20 frames
      let recovered = -1;
      for (let j = i + 1; j < Math.min(i + 20, telemetry.length); j++) {
        if (telemetry[j].Brake > 25) break; // lift into braking = corner entry, not a micro-lift
        if (telemetry[j].Accel > 180) {
          recovered = j;
          break;
        }
      }
      if (recovered !== -1) {
        // Require rear slip near the lift to distinguish from deliberate lifts
        let slipNearby = false;
        for (let j = Math.max(0, i - 10); j <= Math.min(recovered + 10, telemetry.length - 1); j++) {
          const ws = allWheelStates(telemetry[j]);
          if (ws.rl.state === "spin" || ws.rr.state === "spin") {
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

export function detectKerbRiding(telemetry: TelemetryPacket[]): LapInsight | null {
  // Hard kerb strikes: wheel on a rumble strip (when the game reports it)
  // combined with a sharp suspension compression spike at speed. Games that
  // don't report rumble strips (F1, AC Evo) fall back to the spike alone.
  const hasRumble = telemetry.some((p) => p.WheelOnRumbleStripFL > 0 || p.WheelOnRumbleStripFR > 0 || p.WheelOnRumbleStripRL > 0 || p.WheelOnRumbleStripRR > 0);

  const flags: boolean[] = new Array(telemetry.length).fill(false);
  for (let i = 1; i < telemetry.length; i++) {
    const p = telemetry[i];
    if (p.Speed * 2.23694 < 30) continue;
    const prev = telemetry[i - 1];
    const spike = Math.max(
      Math.abs(p.NormSuspensionTravelFL - prev.NormSuspensionTravelFL),
      Math.abs(p.NormSuspensionTravelFR - prev.NormSuspensionTravelFR),
      Math.abs(p.NormSuspensionTravelRL - prev.NormSuspensionTravelRL),
      Math.abs(p.NormSuspensionTravelRR - prev.NormSuspensionTravelRR),
    );
    if (hasRumble) {
      const onKerb = p.WheelOnRumbleStripFL > 0 || p.WheelOnRumbleStripFR > 0 || p.WheelOnRumbleStripRL > 0 || p.WheelOnRumbleStripRR > 0;
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

