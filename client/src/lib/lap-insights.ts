import type { TelemetryPacket } from "@shared/types";
import { allWheelStates } from "./vehicle-dynamics";

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

function groupEvents(flags: boolean[], minFrames: number): [number, number][] {
  const events: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) {
      if (start === -1) start = i;
    } else {
      if (start !== -1 && i - start >= minFrames) {
        events.push([start, i - 1]);
      }
      start = -1;
    }
  }
  if (start !== -1 && flags.length - start >= minFrames) {
    events.push([start, flags.length - 1]);
  }
  return events;
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
      detail: `${side} side ${(Math.abs(avgDelta) * 100).toFixed(0)}% stiffer on average`,
      frameIndices: [Math.round(telemetry.length / 2)],
    };
  }
  return null;
}

function detectTireOverheat(telemetry: TelemetryPacket[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const fields = {
    FL: "TireTempFL",
    FR: "TireTempFR",
    RL: "TireTempRL",
    RR: "TireTempRR",
  } as const;

  const insights: LapInsight[] = [];
  for (const w of wheels) {
    const flags = telemetry.map((p) => p[fields[w]] > 250);
    const events = groupEvents(flags, 10);
    if (events.length > 0) {
      const peak = Math.max(...telemetry.map((p) => p[fields[w]]));
      insights.push({
        id: `tire-overheat-${w}`,
        category: "tires",
        severity: peak > 300 ? "critical" : "warning",
        label: "Tire Overheat",
        detail: `${w} exceeded 250°F (peak ${peak.toFixed(0)}°F)`,
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
    const events = groupEvents(flags, 5);
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
    const events = groupEvents(flags, 5);
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
      detail: `${minLabel} most worn, ${maxLabel} least (${(delta * 100).toFixed(0)}% spread)`,
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
  const events = groupEvents(flags, 3);
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
  const events = groupEvents(flags, 10);
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
  // Pattern: brake zone ends → coasting/no input → throttle applied while still turning
  // This means the driver braked too early, lost speed, then had to accelerate mid-corner
  const brakeFlags = telemetry.map((p) => p.Brake > 10);
  const brakeZones = groupEvents(brakeFlags, 3);
  if (brakeZones.length === 0) return null;

  const events: [number, number][] = [];
  for (const [, brakeEnd] of brakeZones) {
    // After brake release, look for: low throttle gap then throttle while still steering
    let gapFrames = 0;
    let foundThrottleInTurn = false;
    let eventFrame = brakeEnd;
    for (let i = brakeEnd + 1; i < Math.min(brakeEnd + 90, telemetry.length); i++) {
      const p = telemetry[i];
      if (p.Accel < 30 && p.Brake < 10) {
        gapFrames++;
      } else if (p.Accel > 80 && Math.abs(p.Steer) > 20 && gapFrames >= 5) {
        // Driver is accelerating mid-corner after a coast gap = braked too early
        foundThrottleInTurn = true;
        eventFrame = i;
        break;
      } else {
        break; // immediate throttle with no gap = normal corner exit
      }
    }
    if (foundThrottleInTurn) {
      events.push([brakeEnd, eventFrame]);
    }
  }

  if (events.length === 0) return null;
  return {
    id: "driving-early-braking",
    category: "driving",
    severity: events.length >= 4 ? "warning" : "info",
    label: "Early Braking",
    detail: `${events.length} corner${events.length > 1 ? "s" : ""} — braked early, had to accelerate mid-turn`,
    frameIndices: midFrame(events),
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
  const events = groupEvents(flags, 3);
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
  const events = groupEvents(flags, 3);
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
  const lapsRemaining = endFuel > 0 ? endFuel / used : Infinity;
  return {
    id: "mech-fuel",
    category: "mechanical",
    severity: lapsRemaining < 3 ? "critical" : lapsRemaining < 5 ? "warning" : "info",
    label: "Fuel",
    detail: `Used ${(used * 100).toFixed(1)}% — ~${lapsRemaining === Infinity ? "∞" : lapsRemaining.toFixed(1)} laps remaining`,
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

export function analyzeLap(telemetry: TelemetryPacket[]): LapInsight[] {
  if (telemetry.length < 10) return [];

  const insights: LapInsight[] = [];

  // Suspension
  insights.push(...detectSuspensionOverload(telemetry));
  const imbalance = detectSuspensionImbalance(telemetry);
  if (imbalance) insights.push(imbalance);

  // Tires
  insights.push(...detectTireOverheat(telemetry));
  insights.push(...detectLockups(telemetry));
  insights.push(...detectWheelspin(telemetry));
  const wearImb = detectWearImbalance(telemetry);
  if (wearImb) insights.push(wearImb);

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
  const throttleLoss = detectThrottleTractionLoss(telemetry);
  if (throttleLoss) insights.push(throttleLoss);
  const earlyThrottle = detectEarlyThrottle(telemetry);
  if (earlyThrottle) insights.push(earlyThrottle);
  const binary = detectBinaryThrottle(telemetry);
  if (binary) insights.push(binary);

  const brakeDrag = detectBrakeDrag(telemetry);
  if (brakeDrag) insights.push(brakeDrag);

  // Mechanical
  const fuel = detectFuelConsumption(telemetry);
  if (fuel) insights.push(fuel);
  const power = detectPeakPower(telemetry);
  if (power) insights.push(power);
  const boost = detectBoostAnomaly(telemetry);
  if (boost) insights.push(boost);

  return insights;
}
