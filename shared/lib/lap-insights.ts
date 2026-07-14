import type { GameId, TelemetryPacket } from "../types";
import { allWheelStates, steerBalance } from "./vehicle-physics";

export type InsightCategory = "suspension" | "tires" | "driving" | "mechanical";
export type InsightSeverity = "info" | "warning" | "critical";

export interface LapInsight {
  id: string;
  category: InsightCategory;
  severity: InsightSeverity;
  label: string;
  detail: string;
  frameIndices: number[];
}

function groupEvents(flags: boolean[], minFrames: number, mergeGap = 0): [number, number][] {
  // Runs separated by fewer than mergeGap false frames are merged before the
  // minFrames filter, so a flickering signal counts as one event, not several.
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) {
      if (start === -1) start = i;
    } else {
      if (start !== -1) runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start !== -1) runs.push([start, flags.length - 1]);

  const merged: [number, number][] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[0] - last[1] - 1 <= mergeGap) {
      last[1] = run[1];
    } else {
      merged.push([run[0], run[1]]);
    }
  }
  return merged.filter(([s, e]) => e - s + 1 >= minFrames);
}

function midFrame(events: [number, number][]): number[] {
  return events.map(([s, e]) => Math.round((s + e) / 2));
}

function detectSuspensionOverload(telemetry: TelemetryPacket[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const fields = {
    FL: "NormSuspensionTravelFL",
    FR: "NormSuspensionTravelFR",
    RL: "NormSuspensionTravelRL",
    RR: "NormSuspensionTravelRR",
  } as const;

  const insights: LapInsight[] = [];
  for (const w of wheels) {
    const flags = telemetry.map((p) => p[fields[w]] > 0.95);
    const events = groupEvents(flags, 3);
    if (events.length > 0) {
      insights.push({
        id: `susp-overload-${w}`,
        category: "suspension",
        severity: events.length >= 3 ? "critical" : "warning",
        label: "Suspension Overload",
        detail: `${w} bottomed out ${events.length} time${events.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(events),
      });
    }
  }
  return insights;
}

function detectSuspensionImbalance(telemetry: TelemetryPacket[]): LapInsight | null {
  let totalDelta = 0;
  for (const p of telemetry) {
    const left = (p.NormSuspensionTravelFL + p.NormSuspensionTravelRL) / 2;
    const right = (p.NormSuspensionTravelFR + p.NormSuspensionTravelRR) / 2;
    totalDelta += left - right;
  }
  const avgDelta = totalDelta / telemetry.length;
  if (Math.abs(avgDelta) > 0.15) {
    const side = avgDelta > 0 ? "left" : "right";
    return {
      id: "susp-imbalance",
      category: "suspension",
      severity: Math.abs(avgDelta) > 0.25 ? "critical" : "warning",
      label: "Suspension Imbalance",
      detail: `${side} side compressed ${(Math.abs(avgDelta) * 100).toFixed(0)}% more on average — check corner weights/ride height (or a one-direction track)`,
      frameIndices: [Math.round(telemetry.length / 2)],
    };
  }
  return null;
}

function detectTireOverheat(telemetry: TelemetryPacket[], gameId: GameId): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const fields = {
    FL: "TireTempFL",
    FR: "TireTempFR",
    RL: "TireTempRL",
    RR: "TireTempRR",
  } as const;

  // FM reports °F; F1/ACC/AC Evo report °C.
  const fahrenheit = gameId === "fm-2023";
  const warnTemp = fahrenheit ? 250 : 110;
  const critTemp = fahrenheit ? 300 : 130;
  const unit = fahrenheit ? "°F" : "°C";

  const insights: LapInsight[] = [];
  for (const w of wheels) {
    const flags = telemetry.map((p) => p[fields[w]] > warnTemp);
    const events = groupEvents(flags, 10, 30);
    if (events.length > 0) {
      const peak = Math.max(...telemetry.map((p) => p[fields[w]]));
      insights.push({
        id: `tire-overheat-${w}`,
        category: "tires",
        severity: peak > critTemp ? "critical" : "warning",
        label: "Tire Overheat",
        detail: `${w} exceeded ${warnTemp}${unit} (peak ${peak.toFixed(0)}${unit})`,
        frameIndices: midFrame(events),
      });
    }
  }
  return insights;
}

function detectLockups(telemetry: TelemetryPacket[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const insights: LapInsight[] = [];

  for (const w of wheels) {
    const flags = telemetry.map((p) => {
      const ws = allWheelStates(p);
      return ws[w.toLowerCase() as "fl" | "fr" | "rl" | "rr"].state === "lockup";
    });
    const events = groupEvents(flags, 5, 15);
    if (events.length > 0) {
      insights.push({
        id: `tire-lockup-${w}`,
        category: "tires",
        severity: events.length >= 3 ? "critical" : "warning",
        label: "Wheel Lockup",
        detail: `${w} locked ${events.length} time${events.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(events),
      });
    }
  }
  return insights;
}

function detectWheelspin(telemetry: TelemetryPacket[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const insights: LapInsight[] = [];

  for (const w of wheels) {
    const flags = telemetry.map((p) => {
      const ws = allWheelStates(p);
      return ws[w.toLowerCase() as "fl" | "fr" | "rl" | "rr"].state === "spin";
    });
    const events = groupEvents(flags, 5, 15);
    if (events.length > 0) {
      insights.push({
        id: `tire-spin-${w}`,
        category: "tires",
        severity: events.length >= 3 ? "critical" : "warning",
        label: "Wheelspin",
        detail: `${w} spun ${events.length} time${events.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(events),
      });
    }
  }
  return insights;
}

function detectWearImbalance(telemetry: TelemetryPacket[]): LapInsight | null {
  const last = telemetry[telemetry.length - 1];
  if (!last) return null;
  const wears = [last.TireWearFL, last.TireWearFR, last.TireWearRL, last.TireWearRR];
  if (wears.some((w) => w < 0)) return null; // -1 = wear not reported (short FM packet)
  const labels = ["FL", "FR", "RL", "RR"];
  const maxW = Math.max(...wears);
  const minW = Math.min(...wears);
  const delta = maxW - minW;
  if (delta > 0.15) {
    const maxLabel = labels[wears.indexOf(maxW)];
    const minLabel = labels[wears.indexOf(minW)];
    return {
      id: "tire-wear-imbalance",
      category: "tires",
      severity: delta > 0.3 ? "critical" : "warning",
      label: "Wear Imbalance",
      detail: `${maxLabel} most worn, ${minLabel} least (${(delta * 100).toFixed(0)}% spread)`,
      frameIndices: [telemetry.length - 1],
    };
  }
  return null;
}

function detectBrakeTractionLoss(telemetry: TelemetryPacket[]): LapInsight | null {
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

function detectRevLimiter(telemetry: TelemetryPacket[]): LapInsight | null {
  if (telemetry.length === 0) return null;
  const maxRpm = telemetry[0].EngineMaxRpm;
  if (maxRpm === 0) return null;
  const flags = telemetry.map((p) => p.CurrentEngineRpm >= maxRpm - 50);
  const events = groupEvents(flags, 10, 20);
  if (events.length === 0) return null;
  return {
    id: "driving-rev-limiter",
    category: "driving",
    severity: events.length >= 5 ? "warning" : "info",
    label: "Rev Limiter",
    detail: `Hit limiter ${events.length} time${events.length > 1 ? "s" : ""}`,
    frameIndices: midFrame(events),
  };
}

function detectCoasting(telemetry: TelemetryPacket[]): LapInsight | null {
  const flags = telemetry.map((p) => p.Accel < 5 && p.Brake < 5 && p.Speed * 2.23694 > 20);
  const events = groupEvents(flags, 30);
  if (events.length === 0) return null;
  const totalFrames = events.reduce((s, [a, b]) => s + (b - a + 1), 0);
  return {
    id: "driving-coasting",
    category: "driving",
    severity: totalFrames > 120 ? "warning" : "info",
    label: "Coasting",
    detail: `${events.length} zone${events.length > 1 ? "s" : ""}, ${((totalFrames / telemetry.length) * 100).toFixed(1)}% of lap`,
    frameIndices: midFrame(events),
  };
}

function detectTrailBraking(telemetry: TelemetryPacket[]): LapInsight | null {
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

function detectEarlyBraking(telemetry: TelemetryPacket[]): LapInsight | null {
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
  };
}

function detectOverSlowing(telemetry: TelemetryPacket[]): LapInsight | null {
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
  };
}

function detectCounterSteer(telemetry: TelemetryPacket[]): LapInsight | null {
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

function detectThrottleTractionLoss(telemetry: TelemetryPacket[]): LapInsight | null {
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

function detectEarlyThrottle(telemetry: TelemetryPacket[]): LapInsight | null {
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

function detectBinaryThrottle(telemetry: TelemetryPacket[]): LapInsight | null {
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

function detectFuelConsumption(telemetry: TelemetryPacket[]): LapInsight | null {
  if (telemetry.length < 2) return null;
  const startFuel = telemetry[0].Fuel;
  const endFuel = telemetry[telemetry.length - 1].Fuel;
  const used = startFuel - endFuel;
  if (used <= 0) return null;
  const lapsRemaining = endFuel > 0 ? endFuel / used : Number.POSITIVE_INFINITY;
  return {
    id: "mech-fuel",
    category: "mechanical",
    severity: lapsRemaining < 3 ? "critical" : lapsRemaining < 5 ? "warning" : "info",
    label: "Fuel",
    detail: `Used ${(used * 100).toFixed(1)}% — ~${lapsRemaining === Number.POSITIVE_INFINITY ? "∞" : lapsRemaining.toFixed(1)} laps remaining`,
    frameIndices: [telemetry.length - 1],
  };
}

function detectPeakPower(telemetry: TelemetryPacket[]): LapInsight | null {
  if (telemetry.length === 0) return null;
  let peakIdx = 0;
  let peakVal = 0;
  for (let i = 0; i < telemetry.length; i++) {
    if (telemetry[i].Power > peakVal) {
      peakVal = telemetry[i].Power;
      peakIdx = i;
    }
  }
  if (peakVal === 0) return null;
  const pkt = telemetry[peakIdx];
  const hp = peakVal / 745.7;
  return {
    id: "mech-peak-power",
    category: "mechanical",
    severity: "info",
    label: "Peak Power",
    detail: `${hp.toFixed(0)} hp @ ${pkt.CurrentEngineRpm.toFixed(0)} RPM (gear ${pkt.Gear})`,
    frameIndices: [peakIdx],
  };
}

function detectBoostAnomaly(telemetry: TelemetryPacket[]): LapInsight | null {
  const maxBoost = Math.max(...telemetry.map((p) => p.Boost));
  if (maxBoost <= 0) return null;

  const flags: boolean[] = new Array(telemetry.length).fill(false);
  let rollingPeak = 0;
  for (let i = 0; i < telemetry.length; i++) {
    rollingPeak = Math.max(rollingPeak, telemetry[i].Boost);
    if (i >= 60) {
      rollingPeak = 0;
      for (let j = i - 59; j <= i; j++) {
        rollingPeak = Math.max(rollingPeak, telemetry[j].Boost);
      }
    }
    if (telemetry[i].Accel > 240 && rollingPeak > 0 && telemetry[i].Boost < rollingPeak * 0.5) {
      flags[i] = true;
    }
  }
  const events = groupEvents(flags, 5);
  if (events.length === 0) return null;
  return {
    id: "mech-boost-anomaly",
    category: "mechanical",
    severity: events.length >= 3 ? "critical" : "warning",
    label: "Boost Drop",
    detail: `${events.length} unexpected boost drop${events.length > 1 ? "s" : ""} at full throttle`,
    frameIndices: midFrame(events),
  };
}

/**
 * Detect brake drag on straights — light brake applied while on full throttle.
 * Common cause: foot resting on brake pedal, or left-foot braking habit.
 * Costs speed on straights and overheats brakes.
 */
function detectBrakeDrag(telemetry: TelemetryPacket[]): LapInsight | null {
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

function detectDownshiftOverRev(telemetry: TelemetryPacket[]): LapInsight | null {
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

function detectLateBrakingOvershoot(telemetry: TelemetryPacket[]): LapInsight | null {
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

function detectUndersteerScrub(telemetry: TelemetryPacket[]): LapInsight | null {
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

function detectSteeringSawing(telemetry: TelemetryPacket[]): LapInsight | null {
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

function detectThrottleMicroLifts(telemetry: TelemetryPacket[]): LapInsight | null {
  // Repeated small throttle lifts under power with the rear breaking loose —
  // manually doing traction control's job. Signature: near-full throttle,
  // sharp dip, quick recovery, with wheelspin nearby.
  const liftFrames: number[] = [];
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
        if (slipNearby) liftFrames.push(i);
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
  };
}

function detectTireTempSplit(telemetry: TelemetryPacket[], gameId: GameId): LapInsight | null {
  // Persistent front/rear temperature split points at setup balance:
  // hot fronts = understeer-prone, hot rears = oversteer/traction-limited.
  let front = 0;
  let rear = 0;
  let n = 0;
  for (const p of telemetry) {
    if (p.Speed * 2.23694 < 15) continue;
    front += (p.TireTempFL + p.TireTempFR) / 2;
    rear += (p.TireTempRL + p.TireTempRR) / 2;
    n++;
  }
  if (n < 100) return null;
  front /= n;
  rear /= n;
  if (front <= 0 || rear <= 0) return null; // temps not reported

  const fahrenheit = gameId === "fm-2023";
  const warn = fahrenheit ? 25 : 12;
  const crit = fahrenheit ? 45 : 22;
  const unit = fahrenheit ? "°F" : "°C";
  const delta = front - rear;
  if (Math.abs(delta) < warn) return null;

  const hotEnd = delta > 0 ? "front" : "rear";
  const hint = delta > 0 ? "understeer-prone — consider softer front or more front downforce" : "oversteer/traction-limited — consider softer rear or less rear camber";
  return {
    id: "tire-temp-split",
    category: "tires",
    severity: Math.abs(delta) > crit ? "warning" : "info",
    label: "Front/Rear Temp Split",
    detail: `${hotEnd} axle ${Math.abs(delta).toFixed(0)}${unit} hotter on average — ${hint}`,
    frameIndices: [Math.round(telemetry.length / 2)],
  };
}

function detectInnerOuterTempSpread(telemetry: TelemetryPacket[]): LapInsight[] {
  // ACC-only: inner-vs-outer tread temperature spread indicates camber/pressure
  // problems. Sustained inner-hot = too much camber; outer-hot = not enough.
  const labels = ["FL", "FR", "RL", "RR"] as const;
  const sums = [0, 0, 0, 0];
  let n = 0;
  for (const p of telemetry) {
    const acc = p.acc;
    if (!acc || p.Speed * 2.23694 < 15) continue;
    for (let t = 0; t < 4; t++) {
      sums[t] += acc.tireInnerTemp[t] - acc.tireOuterTemp[t];
    }
    n++;
  }
  if (n < 100) return [];

  const insights: LapInsight[] = [];
  for (let t = 0; t < 4; t++) {
    const delta = sums[t] / n; // °C, + = inner hotter
    if (Math.abs(delta) < 8) continue;
    const hint = delta > 0 ? "inner edge running hot — reduce negative camber or raise pressure" : "outer edge running hot — add negative camber";
    insights.push({
      id: `tire-edge-temp-${labels[t]}`,
      category: "tires",
      severity: Math.abs(delta) > 15 ? "warning" : "info",
      label: "Tire Edge Temp Spread",
      detail: `${labels[t]} ${Math.abs(delta).toFixed(0)}°C ${delta > 0 ? "inner" : "outer"}-hot on average — ${hint}`,
      frameIndices: [Math.round(telemetry.length / 2)],
    });
  }
  return insights;
}

function detectKerbRiding(telemetry: TelemetryPacket[]): LapInsight | null {
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

export function analyzeLap(telemetry: TelemetryPacket[], gameId: GameId): LapInsight[] {
  if (telemetry.length < 10) return [];

  const insights: LapInsight[] = [];

  // Suspension
  insights.push(...detectSuspensionOverload(telemetry));
  const imbalance = detectSuspensionImbalance(telemetry);
  if (imbalance) insights.push(imbalance);

  // Tires
  insights.push(...detectTireOverheat(telemetry, gameId));
  insights.push(...detectLockups(telemetry));
  insights.push(...detectWheelspin(telemetry));
  const wearImb = detectWearImbalance(telemetry);
  if (wearImb) insights.push(wearImb);
  const tempSplit = detectTireTempSplit(telemetry, gameId);
  if (tempSplit) insights.push(tempSplit);
  insights.push(...detectInnerOuterTempSpread(telemetry));

  // Driving
  const brakeLoss = detectBrakeTractionLoss(telemetry);
  if (brakeLoss) insights.push(brakeLoss);
  const rev = detectRevLimiter(telemetry);
  if (rev) insights.push(rev);
  const coast = detectCoasting(telemetry);
  if (coast) insights.push(coast);
  const trail = detectTrailBraking(telemetry);
  if (trail) insights.push(trail);
  const counterSteer = detectCounterSteer(telemetry);
  if (counterSteer) insights.push(counterSteer);
  const earlyBrake = detectEarlyBraking(telemetry);
  if (earlyBrake) insights.push(earlyBrake);
  const overSlow = detectOverSlowing(telemetry);
  if (overSlow) insights.push(overSlow);
  const throttleLoss = detectThrottleTractionLoss(telemetry);
  if (throttleLoss) insights.push(throttleLoss);
  const earlyThrottle = detectEarlyThrottle(telemetry);
  if (earlyThrottle) insights.push(earlyThrottle);
  const binary = detectBinaryThrottle(telemetry);
  if (binary) insights.push(binary);

  const brakeDrag = detectBrakeDrag(telemetry);
  if (brakeDrag) insights.push(brakeDrag);
  const downshift = detectDownshiftOverRev(telemetry);
  if (downshift) insights.push(downshift);
  const overshoot = detectLateBrakingOvershoot(telemetry);
  if (overshoot) insights.push(overshoot);
  const scrub = detectUndersteerScrub(telemetry);
  if (scrub) insights.push(scrub);
  const sawing = detectSteeringSawing(telemetry);
  if (sawing) insights.push(sawing);
  const microLifts = detectThrottleMicroLifts(telemetry);
  if (microLifts) insights.push(microLifts);
  const kerbs = detectKerbRiding(telemetry);
  if (kerbs) insights.push(kerbs);

  // Mechanical
  const fuel = detectFuelConsumption(telemetry);
  if (fuel) insights.push(fuel);
  const power = detectPeakPower(telemetry);
  if (power) insights.push(power);
  const boost = detectBoostAnomaly(telemetry);
  if (boost) insights.push(boost);

  return insights;
}
